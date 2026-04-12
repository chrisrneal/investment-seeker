import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseClient } from "@/lib/supabase";
import { estimateCost } from "@/lib/costs";
import { secFetch } from "@/lib/sec";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ApiError, RiskFlag, RiskFlagResult, RiskFlagSeverity } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CACHE_TTL_HOURS = 24;
const DOC_CHAR_LIMIT = 60_000;

const SYSTEM_PROMPT =
  "You are a credit risk analyst and forensic accountant. Scan the provided SEC filing text for the following specific risk flags. For each flag you detect, return it in the JSON array. If a flag is not present, do not include it.\n\n" +
  "Risk flag categories to scan for:\n" +
  '1. "Going concern" — any language about going concern doubts, substantial doubt, or ability to continue as a going concern\n' +
  '2. "Covenant violation" — waiver, violation, default, or non-compliance with debt covenants\n' +
  '3. "Goodwill impairment" — impairment charge, impairment testing failure, or significant goodwill write-down\n' +
  '4. "Revenue concentration" — disclosure that a single customer or partner represents >20% of revenue\n' +
  '5. "Planned dilution" — planned equity offering, at-the-market offering, or significant new share issuance\n' +
  '6. "Insider share pledge" — disclosure that executives or directors have pledged shares as collateral\n' +
  '7. "Auditor change" — change in independent registered accounting firm\n' +
  '8. "Material weakness" — material weakness in internal controls over financial reporting\n' +
  '9. "Liquidity risk" — explicit language about near-term liquidity concerns, cash runway <12 months, or reliance on financing to continue operations\n' +
  '10. "Litigation risk" — pending litigation with potential material adverse effect disclosed\n\n' +
  "For each detected flag return:\n" +
  "- category: exact string from the list above\n" +
  '- severity: "high" if the flag indicates immediate financial risk, "medium" if it is a structural concern, "low" if it is a minor disclosure\n' +
  "- evidence: a brief description of the specific language found (<80 characters), do not quote more than 10 words verbatim\n\n" +
  'Also return overallRiskLevel: "critical" if any high-severity flags present, "high" if 3+ medium flags, "medium" if 1-2 medium flags, "low" if only low-severity flags or none.\n\n' +
  'Return JSON with exactly: { "flags": [...], "overallRiskLevel": "..." }\n' +
  "No preamble, no markdown fences.";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * GET /api/analyze/risk-flags?ticker=TICKER
 *
 * Scans the most recent 10-K (or 10-Q fallback) for structural red flags
 * using Claude Haiku. Cached in risk_flag_cache for 24 hours.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return errorJson("Missing required query param 'ticker'", undefined, 400);
  }

  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3600_000).toISOString();

  // ── Cache check ───────────────────────────────────────────────────
  type CacheRow = { result: unknown };
  const { data: cached } = await supabase
    .from("risk_flag_cache")
    .select("result")
    .eq("ticker", ticker)
    .gte("computed_at", cutoff)
    .maybeSingle() as { data: CacheRow | null; error: unknown };

  if (cached) {
    return NextResponse.json({
      ...(cached.result as RiskFlagResult),
      cached: true,
    });
  }

  // ── Find most recent 10-K or 10-Q ─────────────────────────────────
  type FilingRow = {
    form_type: string; period_of_report: string | null;
    filing_date: string; primary_doc_url: string | null;
  };

  const { data: annualFilings } = await supabase
    .from("annual_filings")
    .select("form_type, period_of_report, filing_date, primary_doc_url")
    .ilike("ticker", ticker)
    .order("filing_date", { ascending: false })
    .limit(10) as { data: FilingRow[] | null; error: unknown };

  // Prefer 10-K, fall back to 10-Q.
  const filing =
    annualFilings?.find((f) => f.form_type === "10-K") ??
    annualFilings?.find((f) => f.form_type === "10-Q") ??
    null;

  if (!filing || !filing.primary_doc_url) {
    return errorJson(
      "No filing found for risk scan",
      `Run POST /api/filings/annual?ticker=${ticker} first to ingest filings.`,
      404
    );
  }

  // ── Fetch filing document ─────────────────────────────────────────
  let filingText: string;
  try {
    const res = await secFetch(filing.primary_doc_url);
    if (!res.ok) {
      return errorJson("Failed to fetch filing document", `HTTP ${res.status}`, 502);
    }
    const raw = await res.text();
    // Strip HTML and truncate.
    const plain = raw
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();

    filingText =
      plain.length > DOC_CHAR_LIMIT
        ? plain.slice(0, DOC_CHAR_LIMIT) + "\n[...truncated]"
        : plain;
  } catch (err) {
    return errorJson(
      "Failed to fetch filing document",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  // ── Call Claude Haiku ─────────────────────────────────────────────
  const anthropic = getAnthropicClient();
  let responseText: string;
  let inputTokens: number;
  let outputTokens: number;
  let cacheReadTokens: number;
  let cacheCreationTokens: number;

  try {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1500,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: filingText }],
    });

    const textBlock = response.content.find((b): b is TextBlock => b.type === "text");
    responseText = textBlock?.text ?? "{}";
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
    const ext = response.usage as unknown as Record<string, number>;
    cacheReadTokens = ext.cache_read_input_tokens ?? 0;
    cacheCreationTokens = ext.cache_creation_input_tokens ?? 0;
  } catch (err) {
    return errorJson(
      "Risk flag scan failed",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  // ── Parse response ────────────────────────────────────────────────
  let parsed: { flags?: unknown[]; overallRiskLevel?: string };
  try {
    const clean = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(clean) as typeof parsed;
  } catch {
    return errorJson(
      "Failed to parse Claude response",
      `Raw: ${responseText.slice(0, 200)}`,
      502
    );
  }

  const cost = estimateCost({
    model: HAIKU_MODEL,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });

  const flags: RiskFlag[] = ((parsed.flags ?? []) as Array<Record<string, string>>).map((f) => ({
    category: f.category ?? "Unknown",
    severity: (f.severity ?? "low") as RiskFlagSeverity,
    evidence: (f.evidence ?? "").slice(0, 80),
  }));

  const result: RiskFlagResult = {
    ticker,
    flags,
    overallRiskLevel: (parsed.overallRiskLevel ?? "low") as RiskFlagResult["overallRiskLevel"],
    filingScanned: filing.period_of_report ?? filing.filing_date,
    modelUsed: HAIKU_MODEL,
    estimatedCost: Math.round(cost * 1_000_000) / 1_000_000,
    cached: false,
  };

  // ── Cache ─────────────────────────────────────────────────────────
  try {
    await supabase.from("risk_flag_cache").upsert(
      { ticker, result, computed_at: new Date().toISOString() },
      { onConflict: "ticker" }
    );
  } catch {
    // Non-fatal.
  }

  return NextResponse.json(result);
}

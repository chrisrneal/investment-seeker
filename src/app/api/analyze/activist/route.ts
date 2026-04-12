import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseClient } from "@/lib/supabase";
import { estimateCost } from "@/lib/costs";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ActivistAnalysisResult, ActivistThesisCategory, ApiError } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SONNET_MODEL = "claude-sonnet-4-6-20260401";
const CACHE_TTL_HOURS = 12;

const SYSTEM_PROMPT =
  "You are a senior activist investment analyst with 20 years of experience analyzing Schedule 13D filings. " +
  "Given one or more Item 4 \"Purpose of Transaction\" excerpts for the same subject company, produce a structured JSON analysis.\n\n" +
  "Return exactly these fields:\n" +
  "- thesisCategory: classify the activist's primary objective as one of exactly: " +
  '"Operational Improvement", "Board Reconstitution", "Strategic Sale / M&A", "Capital Return / Buyback", ' +
  '"Management Change", "Business Separation / Spin-off", "Balance Sheet Restructuring", "Undervaluation / Passive Accumulation"\n' +
  "- specificDemands: array of concrete actions requested or implied (max 5 items, be specific — quote or closely paraphrase the filing language)\n" +
  "- timelineSignals: array of any dates, deadlines, meeting references, or urgency language (empty array if none)\n" +
  '- tone: classify as exactly one of "cooperative", "cautious", or "hostile" based on the language used\n' +
  "- catalystRisk: single string — the most likely reason this activist thesis fails to play out\n" +
  "- convergenceNote: if multiple filers are present, describe whether they appear coordinated or independent; null if single filer\n\n" +
  "Return only valid JSON. No preamble, no markdown fences.";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * GET /api/analyze/activist?ticker=TICKER
 *
 * Analyzes 13D/G Item 4 excerpts using Claude Sonnet.
 * Cached in activist_analysis_cache for 12 hours.
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
    .from("activist_analysis_cache")
    .select("result")
    .eq("ticker", ticker)
    .gte("computed_at", cutoff)
    .maybeSingle() as { data: CacheRow | null; error: unknown };

  if (cached) {
    return NextResponse.json({
      ...(cached.result as ActivistAnalysisResult),
      cached: true,
    });
  }

  // ── Fetch 13D/G filings ───────────────────────────────────────────
  type DGRow = {
    filer_name: string; filer_cik: string | null;
    filing_date: string; percent_of_class: number | null;
    item4_excerpt: string | null; amendment_type: string | null;
  };
  const { data: filings, error: fetchErr } = await supabase
    .from("thirteen_dg_filings")
    .select("filer_name, filer_cik, filing_date, percent_of_class, item4_excerpt, amendment_type")
    .ilike("subject_company_ticker", ticker)
    .order("filing_date", { ascending: false })
    .limit(10) as { data: DGRow[] | null; error: unknown };

  if (fetchErr) {
    return errorJson("Failed to fetch activist filings", String(fetchErr), 500);
  }

  const rows = (filings ?? []).filter((r) => r.item4_excerpt);
  if (rows.length === 0) {
    return errorJson(
      "No 13D/G filings found for ticker",
      "Run the 13D/G ingest pipeline first",
      404
    );
  }

  // Deduplicate by filer_cik, keep most recent per filer.
  const seenCiks = new Set<string>();
  const deduped: DGRow[] = [];
  for (const r of rows) {
    const key = r.filer_cik ?? r.filer_name;
    if (!seenCiks.has(key)) {
      seenCiks.add(key);
      deduped.push(r);
    }
  }

  const filerCount = deduped.length;
  const totalPercentDisclosed = deduped.reduce(
    (sum, r) => sum + (r.percent_of_class ?? 0),
    0
  );
  const oldestFilingDate = rows[rows.length - 1]?.filing_date ?? "";

  // ── Build context ─────────────────────────────────────────────────
  const context =
    `Subject company: ${ticker}\n` +
    `Total filers: ${filerCount}\n` +
    `Aggregate beneficial ownership disclosed: ${totalPercentDisclosed.toFixed(2)}%\n\n` +
    deduped
      .map(
        (r) =>
          `Filer: ${r.filer_name}\n` +
          `Filing date: ${r.filing_date}\n` +
          (r.percent_of_class != null ? `Percent of class: ${r.percent_of_class}%\n` : "") +
          `Amendment: ${r.amendment_type ?? "Original"}\n` +
          `Item 4 Purpose of Transaction:\n${r.item4_excerpt}`
      )
      .join("\n---\n");

  // ── Call Claude Sonnet ────────────────────────────────────────────
  const anthropic = getAnthropicClient();
  let responseText: string;
  let inputTokens: number;
  let outputTokens: number;
  let cacheReadTokens: number;
  let cacheCreationTokens: number;

  try {
    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Analyze the following 13D/G filings for ${ticker}:\n\n${context}`,
        },
      ],
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
      "Activist analysis failed",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  // ── Parse response ────────────────────────────────────────────────
  let parsed: {
    thesisCategory?: string;
    specificDemands?: string[];
    timelineSignals?: string[];
    tone?: string;
    catalystRisk?: string;
    convergenceNote?: string | null;
  };
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
    model: SONNET_MODEL,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });

  const result: ActivistAnalysisResult = {
    ticker,
    thesisCategory: (parsed.thesisCategory ?? "Undervaluation / Passive Accumulation") as ActivistThesisCategory,
    specificDemands: parsed.specificDemands ?? [],
    timelineSignals: parsed.timelineSignals ?? [],
    tone: (parsed.tone ?? "cautious") as ActivistAnalysisResult["tone"],
    catalystRisk: parsed.catalystRisk ?? "",
    convergenceNote: parsed.convergenceNote ?? null,
    filerCount,
    totalPercentDisclosed,
    oldestFilingDate,
    modelUsed: SONNET_MODEL,
    estimatedCost: Math.round(cost * 1_000_000) / 1_000_000,
    cached: false,
  };

  // ── Cache ─────────────────────────────────────────────────────────
  try {
    await supabase.from("activist_analysis_cache").upsert(
      { ticker, result, computed_at: new Date().toISOString() },
      { onConflict: "ticker" }
    );
  } catch {
    // Non-fatal.
  }

  return NextResponse.json(result);
}

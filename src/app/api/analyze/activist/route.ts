import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseClient } from "@/lib/supabase";
import { estimateCost } from "@/lib/costs";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ApiError } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SONNET_MODEL = "claude-sonnet-4-6-20260401";

const SYSTEM_PROMPT =
  "You are an activist investment analyst with deep expertise in Schedule 13D filings. " +
  "Given one or more Item 4 Purpose of Transaction excerpts from 13D filings for the same subject company, " +
  "produce a structured analysis. Classify the activist thesis into the most fitting category from: " +
  "[Operational Improvement, Board Reconstitution, Strategic Sale / M&A, Capital Return / Buyback, " +
  "Management Change, Business Separation / Spin-off, Balance Sheet Restructuring, " +
  "Undervaluation / Passive Accumulation]. Then extract: " +
  "(1) specificDemands — array of concrete demands or actions requested, " +
  "(2) timelineSignals — any dates, deadlines, or urgency language mentioned, " +
  "(3) tone — one of: cooperative, cautious, hostile, " +
  "(4) catalystRisk — the single biggest risk that could prevent the thesis from playing out, " +
  "(5) convergenceNote — if multiple filers are present, describe whether they appear coordinated. " +
  "Return valid JSON only, no preamble.";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

export type ActivistAnalysis = {
  activistThesis: string;
  specificDemands: string[];
  timelineSignals: string[];
  tone: "cooperative" | "cautious" | "hostile";
  catalystRisk: string;
  convergenceNote: string | null;
  filerCount: number;
  totalPercentDisclosed: number | null;
  oldestFilingDate: string | null;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

/**
 * GET /api/analyze/activist?ticker=TICKER
 *
 * Requires authentication. Fetches all 13D/G filings for the ticker,
 * sends Item 4 excerpts to Claude Sonnet for activist thesis analysis,
 * and caches the result in filing_summaries keyed by "activist-analysis:{ticker}".
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const { searchParams } = new URL(req.url);
  const ticker = searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return errorJson("Missing required query param 'ticker'", undefined, 400);
  }

  const cacheKey = `activist-analysis:${ticker}`;
  const supabase = getSupabaseClient();

  // ── Check cache ──
  type SummaryRow = {
    summary: string;
    model_used: string;
    estimated_cost: number;
  };
  const { data: cached } = await supabase
    .from("filing_summaries")
    .select("summary, model_used, estimated_cost")
    .eq("filing_url", cacheKey)
    .eq("deep_analysis", false)
    .maybeSingle() as { data: SummaryRow | null; error: unknown };

  if (cached) {
    try {
      const parsed = JSON.parse(cached.summary) as Omit<ActivistAnalysis, "modelUsed" | "estimatedCost" | "cached">;
      const result: ActivistAnalysis = {
        ...parsed,
        modelUsed: cached.model_used,
        estimatedCost: cached.estimated_cost,
        cached: true,
      };
      return NextResponse.json(result);
    } catch {
      // Cached value malformed — fall through to regenerate
    }
  }

  // ── Fetch 13D/G filings ──
  type DGRow = {
    filer_name: string;
    filing_date: string;
    percent_of_class: number | null;
    item4_excerpt: string | null;
    amendment_type: string | null;
  };
  const { data: filings, error: fetchErr } = await supabase
    .from("thirteen_dg_filings")
    .select("filer_name, filing_date, percent_of_class, item4_excerpt, amendment_type")
    .ilike("subject_company_ticker", ticker)
    .order("filing_date", { ascending: false }) as { data: DGRow[] | null; error: unknown };

  if (fetchErr) {
    return errorJson("Failed to fetch activist filings", String(fetchErr), 500);
  }

  const rows = (filings ?? []).filter((r) => r.item4_excerpt);
  if (rows.length === 0) {
    return errorJson(
      "No activist filings found",
      `No 13D/G filings with Item 4 excerpts found for ${ticker}.`,
      404,
    );
  }

  // ── Build context string ──
  const filerNames = [...new Set(rows.map((r) => r.filer_name))];
  const filerCount = filerNames.length;
  const totalPercentDisclosed =
    rows.reduce((sum, r) => sum + (r.percent_of_class ?? 0), 0) || null;
  const oldestFilingDate = rows[rows.length - 1]?.filing_date ?? null;

  const context = rows
    .map(
      (r, i) =>
        `--- Filing ${i + 1} ---\n` +
        `Filer: ${r.filer_name}\n` +
        `Date: ${r.filing_date}\n` +
        (r.percent_of_class != null ? `% of Class: ${r.percent_of_class}%\n` : "") +
        (r.amendment_type ? `Amendment: ${r.amendment_type}\n` : "") +
        `Item 4 (Purpose of Transaction):\n${r.item4_excerpt}`
    )
    .join("\n\n");

  // ── Call Claude Sonnet ──
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
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
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
    const usageExt = response.usage as unknown as Record<string, number>;
    cacheReadTokens = usageExt.cache_read_input_tokens ?? 0;
    cacheCreationTokens = usageExt.cache_creation_input_tokens ?? 0;
  } catch (err) {
    return errorJson(
      "Activist analysis failed",
      err instanceof Error ? err.message : "Unknown error",
      502,
    );
  }

  // ── Parse Claude response ──
  let parsed: {
    activistThesis?: string;
    specificDemands?: string[];
    timelineSignals?: string[];
    tone?: string;
    catalystRisk?: string;
    convergenceNote?: string | null;
  };
  try {
    // Strip markdown code fences if present
    const clean = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    parsed = JSON.parse(clean) as typeof parsed;
  } catch {
    return errorJson(
      "Failed to parse Claude response",
      `Raw response: ${responseText.slice(0, 200)}`,
      502,
    );
  }

  const cost = estimateCost({
    model: SONNET_MODEL,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });

  const analysisPayload = {
    activistThesis: parsed.activistThesis ?? "Unknown",
    specificDemands: parsed.specificDemands ?? [],
    timelineSignals: parsed.timelineSignals ?? [],
    tone: (parsed.tone ?? "cautious") as ActivistAnalysis["tone"],
    catalystRisk: parsed.catalystRisk ?? "",
    convergenceNote: parsed.convergenceNote ?? null,
    filerCount,
    totalPercentDisclosed: totalPercentDisclosed ?? null,
    oldestFilingDate,
  };

  // ── Cache in filing_summaries ──
  try {
    await supabase.from("filing_summaries").upsert(
      {
        filing_url: cacheKey,
        deep_analysis: false,
        summary: JSON.stringify(analysisPayload),
        impact_rating: "Neutral",
        flags: [],
        model_used: SONNET_MODEL,
        estimated_cost: Math.round(cost * 1_000_000) / 1_000_000,
        created_at: new Date().toISOString(),
      },
      { onConflict: "filing_url,deep_analysis" },
    );
  } catch {
    // Non-fatal — return result even if caching fails
  }

  const result: ActivistAnalysis = {
    ...analysisPayload,
    modelUsed: SONNET_MODEL,
    estimatedCost: Math.round(cost * 1_000_000) / 1_000_000,
    cached: false,
  };

  return NextResponse.json(result);
}

import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseClient } from "@/lib/supabase";
import { estimateCost } from "@/lib/costs";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ApiError, EarningsSentimentResult } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SONNET_MODEL = "claude-sonnet-4-6-20260401";
const CACHE_TTL_HOURS = 24;

const SYSTEM_PROMPT =
  "You are a forensic accounting analyst specializing in detecting early warning signals in SEC filings. " +
  "You compare consecutive quarterly MD&A sections to identify material changes in management tone and disclosure posture.\n\n" +
  "Analyze the two MD&A excerpts provided and produce a structured JSON response with exactly these fields:\n" +
  '- sentimentDelta: one of "improving", "deteriorating", or "stable"\n' +
  "- keyThemeChanges: array of strings describing topics that appeared, disappeared, or changed materially between the two filings (max 5 items)\n" +
  "- redFlags: array of strings identifying specific language that suggests elevated risk — include direct references to the text (max 4 items, empty array if none)\n" +
  "- confidenceSignals: array of strings identifying language that suggests management confidence or positive momentum (max 4 items, empty array if none)\n" +
  '- quarterCompared: a string like "Q3 2024 vs Q2 2024" based on the period_of_report values\n\n' +
  "Return only valid JSON. No preamble, no markdown fences.";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * GET /api/analyze/earnings-sentiment?ticker=TICKER
 *
 * Compares the two most recent MD&A sections for the ticker using Claude Sonnet
 * to detect tone shifts, new risks, and confidence signals.
 * Results are cached in earnings_sentiment_cache for 24 hours.
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
  type CacheRow = { result: unknown; computed_at: string };
  const { data: cached } = await supabase
    .from("earnings_sentiment_cache")
    .select("result, computed_at")
    .eq("ticker", ticker)
    .gte("computed_at", cutoff)
    .maybeSingle() as { data: CacheRow | null; error: unknown };

  if (cached) {
    return NextResponse.json({
      ...(cached.result as EarningsSentimentResult),
      cached: true,
    });
  }

  // ── Fetch 2 most recent filings ───────────────────────────────────
  type FilingRow = {
    id: number; form_type: string; filing_date: string;
    period_of_report: string | null; mda_excerpt: string;
  };
  const { data: filings, error: filingsErr } = await supabase
    .from("annual_filings")
    .select("id, form_type, filing_date, period_of_report, mda_excerpt")
    .ilike("ticker", ticker)
    .order("filing_date", { ascending: false })
    .limit(2) as { data: FilingRow[] | null; error: unknown };

  if (filingsErr) {
    return errorJson("Failed to fetch annual filings", String(filingsErr), 500);
  }

  if (!filings || filings.length < 2) {
    const insufficient: EarningsSentimentResult = {
      ticker,
      sentimentDelta: "insufficient_data",
      keyThemeChanges: [],
      redFlags: [],
      confidenceSignals: [],
      quarterCompared: "",
      modelUsed: SONNET_MODEL,
      estimatedCost: 0,
      cached: false,
    };
    return NextResponse.json(insufficient);
  }

  const [recent, prior] = filings;

  // ── Build context ─────────────────────────────────────────────────
  const context =
    `FILING 1 (more recent): ${recent.period_of_report ?? recent.filing_date} ${recent.form_type}\n` +
    `${recent.mda_excerpt}\n\n` +
    `FILING 2 (prior period): ${prior.period_of_report ?? prior.filing_date} ${prior.form_type}\n` +
    `${prior.mda_excerpt}`;

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
      messages: [{ role: "user", content: context }],
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
      "Earnings sentiment analysis failed",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  // ── Parse response ────────────────────────────────────────────────
  let parsed: {
    sentimentDelta?: string;
    keyThemeChanges?: string[];
    redFlags?: string[];
    confidenceSignals?: string[];
    quarterCompared?: string;
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

  const result: EarningsSentimentResult = {
    ticker,
    sentimentDelta: (parsed.sentimentDelta ?? "stable") as EarningsSentimentResult["sentimentDelta"],
    keyThemeChanges: parsed.keyThemeChanges ?? [],
    redFlags: parsed.redFlags ?? [],
    confidenceSignals: parsed.confidenceSignals ?? [],
    quarterCompared: parsed.quarterCompared ?? "",
    modelUsed: SONNET_MODEL,
    estimatedCost: Math.round(cost * 1_000_000) / 1_000_000,
    cached: false,
  };

  // ── Cache ─────────────────────────────────────────────────────────
  try {
    await supabase.from("earnings_sentiment_cache").upsert(
      { ticker, result, computed_at: new Date().toISOString() },
      { onConflict: "ticker" }
    );
  } catch {
    // Non-fatal.
  }

  return NextResponse.json(result);
}

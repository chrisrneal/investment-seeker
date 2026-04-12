import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import { estimateCost } from "@/lib/costs";
import { assembleSignalContext } from "@/lib/assembleSignalContext";
import type { ApiError, AIRecommendation } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_HOURS = 6;
const SONNET_MODEL = "claude-sonnet-4-6";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

const SYSTEM_PROMPT = `You are a senior equity analyst at a long/short hedge fund. You have received a structured signal report for a publicly traded stock. Synthesize all available signals — insider activity, earnings tone, activist presence, risk flags, and fundamentals — into a single actionable recommendation.

Be direct and conviction-driven. "Hold" is only appropriate when signals are genuinely mixed with no dominant direction. If insider conviction is strong and risks are manageable, say Buy. If risk flags dominate or insider signal is absent, lean Sell or Hold. Do not default to safety.

Return a JSON object with exactly these fields:
- verdict: one of exactly "Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"
- confidenceLevel: integer 1–5 (1=insufficient data, 5=high conviction across all signals)
- thesis: 2–3 sentence primary thesis referencing specific signals from the report
- entryLogic: one sentence — optimal entry condition (price level, event trigger, or time horizon)
- keyRisks: array of up to 4 specific risk statements that could invalidate the thesis
- positionSizing: one of exactly "Full", "Half", "Starter", "Avoid"
- positionSizingRationale: one sentence explaining the sizing
- catalysts: array of up to 3 near-term specific catalysts that could re-rate the stock

Return only valid JSON. No preamble, no markdown fences.`;

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const ticker = new URL(req.url).searchParams
    .get("ticker")
    ?.trim()
    .toUpperCase();
  if (!ticker || ticker.length > 10) {
    return errorJson("Missing or invalid 'ticker' query param", undefined, 400);
  }

  const supabase = getSupabaseClient();

  // ── Cache check ──────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3600_000).toISOString();
  const { data: cached } = await supabase
    .from("recommendation_cache")
    .select("result")
    .eq("ticker", ticker)
    .gte("computed_at", cutoff)
    .maybeSingle() as { data: { result: unknown } | null; error: unknown };

  if (cached) {
    return NextResponse.json({ ...(cached.result as object), cached: true });
  }

  // ── Verify company exists ────────────────────────────────────────
  const { data: co } = await supabase
    .from("companies")
    .select("name")
    .ilike("ticker", ticker)
    .maybeSingle() as { data: { name: string } | null; error: unknown };

  if (!co) {
    return errorJson("Company not found", `No company with ticker '${ticker}'`, 404);
  }

  // ── Assemble signal context ──────────────────────────────────────
  const { contextString, signalSummary, companyName } =
    await assembleSignalContext(ticker);

  // ── Call Claude ──────────────────────────────────────────────────
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1500,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: `Signal report:\n\n${contextString}` }],
  });

  const textBlock = response.content.find(
    (b): b is TextBlock => b.type === "text"
  );
  const responseText = textBlock?.text ?? "{}";

  // Parse JSON
  let parsed: Record<string, unknown>;
  try {
    const clean = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    return errorJson(
      "Failed to parse AI response",
      e instanceof Error ? e.message : "Malformed JSON",
      502
    );
  }

  // ── Cost tracking ────────────────────────────────────────────────
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const { cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } =
    response.usage as unknown as Record<string, number>;

  const cost = estimateCost({
    model: SONNET_MODEL,
    inputTokens,
    outputTokens,
    cacheReadTokens: cache_read_input_tokens,
    cacheCreationTokens: cache_creation_input_tokens,
  });

  // ── Assemble full recommendation ─────────────────────────────────
  const result: AIRecommendation = {
    ticker,
    companyName,
    verdict: parsed.verdict as AIRecommendation["verdict"],
    confidenceLevel: parsed.confidenceLevel as AIRecommendation["confidenceLevel"],
    thesis: String(parsed.thesis ?? ""),
    entryLogic: String(parsed.entryLogic ?? ""),
    keyRisks: Array.isArray(parsed.keyRisks)
      ? parsed.keyRisks.map(String)
      : [],
    positionSizing: parsed.positionSizing as AIRecommendation["positionSizing"],
    positionSizingRationale: String(parsed.positionSizingRationale ?? ""),
    catalysts: Array.isArray(parsed.catalysts)
      ? parsed.catalysts.map(String)
      : [],
    signalSummary,
    modelUsed: SONNET_MODEL,
    estimatedCost: Math.round(cost * 1_000_000) / 1_000_000,
    cached: false,
    generatedAt: new Date().toISOString(),
  };

  // ── Cache upsert ─────────────────────────────────────────────────
  await supabase.from("recommendation_cache").upsert(
    {
      ticker,
      result: result as unknown as Record<string, unknown>,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "ticker" }
  );

  return NextResponse.json(result);
}

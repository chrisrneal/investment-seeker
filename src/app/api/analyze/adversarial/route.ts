import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import { estimateCost } from "@/lib/costs";
import { assembleSignalContext } from "@/lib/assembleSignalContext";
import type { ApiError, AIRecommendation, AdversarialDebate } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_HOURS = 12;
const SONNET_MODEL = "claude-sonnet-4-6";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

const BEAR_SYSTEM_PROMPT = `You are a short-seller and skeptical analyst. Construct the strongest possible bear case for this stock given the signal report. You are adversarially inclined — find what bulls are missing, what risks are understated, what assumptions are most likely wrong. Do not hedge or hedge. Be direct and specific. Reference actual signals from the report.

Return JSON with exactly:
- coreArgument: string (2–3 sentences — the single most compelling bear thesis)
- fragileAssumptions: array of up to 3 strings (what the bull thesis requires to be true)
- likelyFailureMode: string (the single most probable specific reason this trade fails — be concrete)
- catalystsThatConfirmBear: array of up to 3 strings (events that would validate the bear)

Return only valid JSON. No preamble, no markdown fences.`;

const BULL_SYSTEM_PROMPT = `You are a long-biased fundamental analyst. You have read a bear case for a stock you are considering. Construct the strongest counter-argument: what is the bear wrong about, what are they underweighting, why does risk/reward still favor the long. Be specific and reference the signals. Push back hard where evidence supports it.

Return JSON with exactly:
- coreCounter: string (2–3 sentences directly rebutting the bear's core argument)
- bearCaseWeaknesses: array of up to 3 strings (what the bear is underweighting or getting wrong)
- asymmetryArgument: string (one sentence — why upside outweighs downside risk)

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
    .from("adversarial_cache")
    .select("result")
    .eq("ticker", ticker)
    .gte("computed_at", cutoff)
    .maybeSingle() as { data: { result: unknown } | null; error: unknown };

  if (cached) {
    return NextResponse.json({ ...(cached.result as object), cached: true });
  }

  // ── Assemble signal context ──────────────────────────────────────
  const { contextString } = await assembleSignalContext(ticker);

  // ── Read existing recommendation ─────────────────────────────────
  const { data: recCached } = await supabase
    .from("recommendation_cache")
    .select("result")
    .eq("ticker", ticker)
    .maybeSingle() as { data: { result: unknown } | null; error: unknown };
  const rec = recCached?.result as AIRecommendation | null;

  const anthropic = getAnthropicClient();

  // ── Bear case call ───────────────────────────────────────────────
  const bearResponse = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1000,
    system: [
      {
        type: "text",
        text: BEAR_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Signal report:\n\n${contextString}\n\nExisting recommendation (if any): ${rec?.verdict ?? "None"} — ${rec?.thesis ?? "No recommendation generated yet"}`,
      },
    ],
  });

  const bearText =
    bearResponse.content.find((b): b is TextBlock => b.type === "text")?.text ??
    "{}";

  let bearCase: AdversarialDebate["bearCase"];
  try {
    const clean = bearText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    bearCase = JSON.parse(clean);
  } catch (e) {
    return errorJson(
      "Failed to parse bear case response",
      e instanceof Error ? e.message : "Malformed JSON",
      502
    );
  }

  // ── Bull rebuttal call ───────────────────────────────────────────
  const bullResponse = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 800,
    system: [
      {
        type: "text",
        text: BULL_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Signal report:\n\n${contextString}\n\nBear case to rebut:\n${bearCase.coreArgument}\n\nBear's fragile assumptions:\n${bearCase.fragileAssumptions.map((a) => `- ${a}`).join("\n")}`,
      },
    ],
  });

  const bullText =
    bullResponse.content.find((b): b is TextBlock => b.type === "text")?.text ??
    "{}";

  let bullRebuttal: AdversarialDebate["bullRebuttal"];
  try {
    const clean = bullText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    bullRebuttal = JSON.parse(clean);
  } catch (e) {
    return errorJson(
      "Failed to parse bull rebuttal response",
      e instanceof Error ? e.message : "Malformed JSON",
      502
    );
  }

  // ── Debate verdict ───────────────────────────────────────────────
  let debateVerdict: AdversarialDebate["debateVerdict"];
  if (rec?.verdict === "Strong Buy" || rec?.verdict === "Buy") {
    debateVerdict = "Bull wins";
  } else if (rec?.verdict === "Strong Sell" || rec?.verdict === "Sell") {
    debateVerdict = "Bear wins";
  } else {
    debateVerdict = "Contested";
  }
  const debateVerdictRationale = rec
    ? `Existing ${rec.verdict} recommendation (confidence ${rec.confidenceLevel}/5) weighted against bear's failure mode.`
    : "No existing recommendation — verdict based on signal balance alone.";

  // ── Cost tracking ────────────────────────────────────────────────
  const bearUsage = bearResponse.usage as unknown as Record<string, number>;
  const bullUsage = bullResponse.usage as unknown as Record<string, number>;

  const bearCost = estimateCost({
    model: SONNET_MODEL,
    inputTokens: bearUsage.input_tokens,
    outputTokens: bearUsage.output_tokens,
    cacheReadTokens: bearUsage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: bearUsage.cache_creation_input_tokens ?? 0,
  });
  const bullCost = estimateCost({
    model: SONNET_MODEL,
    inputTokens: bullUsage.input_tokens,
    outputTokens: bullUsage.output_tokens,
    cacheReadTokens: bullUsage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: bullUsage.cache_creation_input_tokens ?? 0,
  });

  const totalCost = Math.round((bearCost + bullCost) * 1_000_000) / 1_000_000;

  // ── Assemble result ──────────────────────────────────────────────
  const result: AdversarialDebate = {
    ticker,
    bearCase,
    bullRebuttal,
    debateVerdict,
    debateVerdictRationale,
    modelUsed: SONNET_MODEL,
    estimatedCost: totalCost,
    cached: false,
    generatedAt: new Date().toISOString(),
  };

  // ── Cache upsert ─────────────────────────────────────────────────
  await supabase.from("adversarial_cache").upsert(
    {
      ticker,
      result: result as unknown as Record<string, unknown>,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "ticker" }
  );

  return NextResponse.json(result);
}

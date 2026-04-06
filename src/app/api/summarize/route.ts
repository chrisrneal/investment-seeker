import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseClient } from "@/lib/supabase";
import { estimateCost } from "@/lib/costs";
import { secFetch } from "@/lib/sec";
import { parseForm4 } from "@/lib/parseForm4";
import type { ApiError, FilingSummary, ImpactRating, SummaryTransaction } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Static system prompt (cached across requests) ──────────────────

const SYSTEM_PROMPT =
  "You are a financial analyst. Summarize this SEC filing in 3-4 sentences focusing on material impact to shareholders. Flag any red flags or notable positives. Rate the filing's likely impact as: Positive, Negative, Neutral, or Mixed.";

// ── Models ─────────────────────────────────────────────────────────

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6-20260401";

// ── Helpers ────────────────────────────────────────────────────────

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

function parseImpactRating(text: string): ImpactRating {
  const lower = text.toLowerCase();
  if (lower.includes("positive")) return "Positive";
  if (lower.includes("negative")) return "Negative";
  if (lower.includes("mixed")) return "Mixed";
  return "Neutral";
}

function extractFlags(text: string): string[] {
  const flags: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    // Look for lines that look like flags/bullet points about concerns or positives
    const trimmed = line.trim();
    if (/^[-*•]\s*(red flag|flag|notable|concern|positive|warning)/i.test(trimmed)) {
      flags.push(trimmed.replace(/^[-*•]\s*/, ""));
    }
  }
  // If no structured flags found, try to extract from sentences mentioning "red flag" or "notable"
  if (flags.length === 0) {
    const sentences = text.split(/[.!]\s+/);
    for (const s of sentences) {
      if (/red flag|concern|warning|notable positive/i.test(s)) {
        flags.push(s.trim());
      }
    }
  }
  return flags;
}

// ── Route handler ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const filingUrl = searchParams.get("url");
  const deepAnalysis = searchParams.get("deep_analysis") === "true";
  const filingType = searchParams.get("filing_type") || null;

  if (!filingUrl) {
    return errorJson(
      "Missing required query param 'url'",
      "Provide the URL to an SEC filing document.",
      400
    );
  }

  // Validate the URL points to SEC
  try {
    const parsed = new URL(filingUrl);
    if (!parsed.hostname.endsWith(".sec.gov")) {
      return errorJson(
        "Invalid filing URL",
        "URL must point to an sec.gov domain.",
        400
      );
    }
  } catch {
    return errorJson("Invalid URL format", undefined, 400);
  }

  // ── Check Supabase cache ──
  let supabase: ReturnType<typeof getSupabaseClient> | null = null;
  try {
    supabase = getSupabaseClient();
    const { data: cached, error: cacheError } = await supabase
      .from("filing_summaries")
      .select("summary, impact_rating, flags, ticker, issuer_name, filing_type, transactions, model_used, estimated_cost")
      .eq("filing_url", filingUrl)
      .eq("deep_analysis", deepAnalysis)
      .maybeSingle();

    // If the new columns don't exist yet, retry with the original columns
    if (cacheError && !cached) {
      const { data: legacyCached } = await supabase
        .from("filing_summaries")
        .select("summary, impact_rating, flags, model_used, estimated_cost")
        .eq("filing_url", filingUrl)
        .eq("deep_analysis", deepAnalysis)
        .maybeSingle();

      if (legacyCached) {
        const result: FilingSummary = {
          summary: legacyCached.summary,
          impactRating: legacyCached.impact_rating as ImpactRating,
          flags: legacyCached.flags ?? [],
          ticker: null,
          issuerName: null,
          filingType: null,
          transactions: [],
          modelUsed: legacyCached.model_used,
          estimatedCost: legacyCached.estimated_cost,
          cached: true,
        };
        return NextResponse.json(result);
      }
    }

    if (cached) {
      const result: FilingSummary = {
        summary: cached.summary,
        impactRating: cached.impact_rating as ImpactRating,
        flags: cached.flags ?? [],
        ticker: cached.ticker ?? null,
        issuerName: cached.issuer_name ?? null,
        filingType: cached.filing_type ?? null,
        transactions: cached.transactions ?? [],
        modelUsed: cached.model_used,
        estimatedCost: cached.estimated_cost,
        cached: true,
      };
      return NextResponse.json(result);
    }
  } catch {
    // Supabase unavailable — continue without cache.
    supabase = null;
  }

  // ── Fetch the filing content ──
  let filingText: string;
  try {
    const res = await secFetch(filingUrl);
    if (!res.ok) {
      return errorJson(
        "Failed to fetch filing",
        `SEC returned ${res.status}`,
        502
      );
    }
    filingText = await res.text();
    // Truncate to ~100K chars to stay within context window limits.
    if (filingText.length > 100_000) {
      filingText = filingText.slice(0, 100_000) + "\n[...truncated]";
    }
  } catch (err) {
    return errorJson(
      "Failed to fetch filing",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  // ── Parse structured transaction data for Form 4 ──
  let transactions: SummaryTransaction[] = [];
  let ticker: string | null = null;
  let issuerName: string | null = null;

  if (["3", "4", "5"].includes(filingType ?? "")) {
    try {
      // Find the raw XML document URL from the index page.
      // EDGAR index pages list two XML links — an XSL-rendered HTML
      // view (contains "xsl" in path) and the raw XML. We need the raw one.
      const xmlMatches = [...filingText.matchAll(/href="([^"]*\.xml)"/gi)];
      const rawXmlHref = xmlMatches
        .map((m) => m[1])
        .find((href) => !href.includes("/xsl"));
      if (rawXmlHref) {
        // Resolve relative paths against the index page URL
        const xmlUrl = rawXmlHref.startsWith("http")
          ? rawXmlHref
          : new URL(rawXmlHref, filingUrl).toString();
        const parsed = await parseForm4(xmlUrl);
        ticker = parsed.issuerTicker || null;
        issuerName = parsed.issuerName || null;
        transactions = parsed.transactions.map((t) => ({
          transactionDate: t.transactionDate,
          transactionType: t.transactionType,
          officerName: t.officerName,
          officerTitle: t.officerTitle,
          shares: t.sharesTraded,
          pricePerShare: t.pricePerShare,
          totalValue: t.totalValue,
          sharesOwnedAfter: t.sharesOwnedAfter,
        }));
      }
    } catch {
      // Non-fatal: continue with AI summary even if XML parsing fails.
    }
  }

  // ── Call Claude ──
  const model = deepAnalysis ? SONNET_MODEL : HAIKU_MODEL;
  const anthropic = getAnthropicClient();

  try {
    const response = await anthropic.messages.create({
      model,
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
          content: `Here is the SEC filing content:\n\n${filingText}`,
        },
      ],
    });

    const textContent = response.content.find(
      (b): b is TextBlock => b.type === "text"
    );
    const summaryText = textContent?.text ?? "";

    const impactRating = parseImpactRating(summaryText);
    const flags = extractFlags(summaryText);

    const usage = response.usage;
    const cost = estimateCost({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: (usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
      cacheCreationTokens: (usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
    });

    const result: FilingSummary = {
      summary: summaryText,
      impactRating,
      flags,
      ticker,
      issuerName,
      filingType,
      transactions,
      modelUsed: model,
      estimatedCost: Math.round(cost * 1_000_000) / 1_000_000, // 6dp
      cached: false,
    };

    // ── Store in Supabase ──
    if (supabase) {
      try {
        await supabase.from("filing_summaries").upsert(
          {
            filing_url: filingUrl,
            deep_analysis: deepAnalysis,
            summary: result.summary,
            impact_rating: result.impactRating,
            flags: result.flags,
            ticker: result.ticker,
            issuer_name: result.issuerName,
            filing_type: result.filingType,
            transactions: result.transactions,
            model_used: result.modelUsed,
            estimated_cost: result.estimatedCost,
            created_at: new Date().toISOString(),
          },
          { onConflict: "filing_url,deep_analysis" }
        );
      } catch {
        // Non-fatal: caching failure shouldn't break the response.
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    return errorJson(
      "Summarization failed",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }
}

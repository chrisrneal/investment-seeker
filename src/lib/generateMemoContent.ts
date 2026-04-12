import { getSupabaseClient } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { assembleSignalContext } from "@/lib/assembleSignalContext";
import type { AIRecommendation, MemoSection } from "@/lib/types";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages";

const SONNET_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a senior equity analyst writing an internal research memo for a hedge fund portfolio manager. You have a full signal report for a publicly traded company. Write a structured research memo that is direct, specific, and references actual data from the signal report. Avoid generic filler.

Write the memo with these exact section headers in this order. Use "# Section Title" for each header. Use "- item" for bullet lists. Use "**text**" for bold. Plain text only — no tables, no markdown code blocks.

Sections:
# Executive Summary
(3–4 sentences: verdict, primary thesis, key risk, position sizing)

# Investment Thesis
(2–3 paragraphs: why compelling, what the market is mispricing, what insider activity signals)

# Insider Signal Analysis
(1–2 paragraphs: who bought, transaction size, what it implies about management's view)

# Earnings Quality Assessment
(1–2 paragraphs: sentiment direction, material theme changes, any red flags in disclosure language)

# Activist & Institutional Activity
(1 paragraph: activist presence or absence, thesis category if present, what it implies)

# Risk Assessment
(bullet list — format each as "- Risk: [Name] — [one sentence description and mitigation]")

# Entry & Exit Framework
(bullet list — cover: entry trigger, target holding period, stop-loss logic, exit catalysts)

# Signal Scorecard
(plain text table — write as lines: "Composite Score: X/100", "Insider Buy Value: $X", "Earnings Sentiment: X", "Activist Present: Yes/No", "Risk Flags: N (H high severity)", etc.)`;

export async function generateMemoContent(
  ticker: string,
  companyName: string
): Promise<MemoSection[]> {
  const { contextString } = await assembleSignalContext(ticker);

  const supabase = getSupabaseClient();
  const { data: recCached } = await supabase
    .from("recommendation_cache")
    .select("result")
    .eq("ticker", ticker.toUpperCase())
    .maybeSingle() as { data: { result: unknown } | null; error: unknown };

  const rec = recCached?.result as AIRecommendation | null;

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 3000,
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
        content: `Company: ${companyName} (${ticker.toUpperCase()})\n\n${contextString}\n\nExisting recommendation: ${rec?.verdict ?? "Not generated"} (confidence ${rec?.confidenceLevel ?? "N/A"}/5)\n${rec?.thesis ?? ""}`,
      },
    ],
  });

  const textBlock = response.content.find(
    (b): b is TextBlock => b.type === "text"
  );
  const text = textBlock?.text ?? "";

  // Parse sections by splitting on "# " headers
  const rawSections = text.split(/\n(?=# )/);
  const sections: MemoSection[] = rawSections
    .map((raw) => {
      const firstNewline = raw.indexOf("\n");
      if (firstNewline === -1) return { title: raw.replace(/^#\s*/, "").trim(), content: "" };
      const title = raw.slice(0, firstNewline).replace(/^#\s*/, "").trim();
      const content = raw.slice(firstNewline + 1).trim();
      return { title, content };
    })
    .filter((s) => s.title && s.content);

  return sections;
}

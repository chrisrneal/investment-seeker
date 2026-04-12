import { getSupabaseClient } from "@/lib/supabase";
import type {
  AIRecommendation,
  EarningsSentimentResult,
  ActivistAnalysisResult,
  RiskFlagResult,
  CompositeScoreBreakdown,
  FundamentalsSnapshot,
} from "@/lib/types";

export async function assembleSignalContext(ticker: string): Promise<{
  contextString: string;
  signalSummary: AIRecommendation["signalSummary"];
  companyName: string;
}> {
  const supabase = getSupabaseClient();
  const upperTicker = ticker.toUpperCase();

  // 1. Company name
  let companyName = upperTicker;
  let companyCik: string | null = null;
  try {
    const { data: co } = await supabase
      .from("companies")
      .select("name, cik")
      .ilike("ticker", ticker)
      .maybeSingle();
    if (co?.name) companyName = co.name;
    if (co?.cik) companyCik = co.cik;
  } catch {
    // fallback to ticker string
  }

  // 2. Insider transactions (last 90 days)
  let insiderTxnCount = 0;
  let insiderBuyValue = 0;
  let uniqueBuyerCount = 0;
  try {
    const cutoff90d = new Date(Date.now() - 90 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (companyCik) {
      const { data: txns } = await supabase
        .from("transactions")
        .select("total_value, insider_cik")
        .eq("company_cik", companyCik)
        .eq("transaction_type", "buy")
        .gte("transaction_date", cutoff90d)
        .limit(50);
      if (txns) {
        insiderTxnCount = txns.length;
        insiderBuyValue = txns.reduce(
          (sum, t) => sum + (Number(t.total_value) || 0),
          0
        );
        uniqueBuyerCount = new Set(txns.map((t) => t.insider_cik)).size;
      }
    }
  } catch {
    // degrade gracefully
  }

  // 3. Composite score cache
  let compTotal: number | null = null;
  let breakdown: CompositeScoreBreakdown | null = null;
  let fundamentals: FundamentalsSnapshot | null = null;
  let rationale: string | null = null;
  try {
    const { data: comp } = await supabase
      .from("composite_score_cache")
      .select("total, breakdown, fundamentals, rationale")
      .eq("ticker", upperTicker)
      .maybeSingle();
    if (comp) {
      compTotal = comp.total as number | null;
      breakdown = comp.breakdown as CompositeScoreBreakdown | null;
      fundamentals = comp.fundamentals as FundamentalsSnapshot | null;
      rationale = comp.rationale as string | null;
    }
  } catch {
    // degrade gracefully
  }

  // 4. Earnings sentiment cache
  let sentResult: EarningsSentimentResult | null = null;
  try {
    const { data: sent } = await supabase
      .from("earnings_sentiment_cache")
      .select("result")
      .eq("ticker", upperTicker)
      .maybeSingle();
    sentResult = (sent?.result as EarningsSentimentResult) ?? null;
  } catch {
    // degrade gracefully
  }

  // 5. Activist cache
  let actResult: ActivistAnalysisResult | null = null;
  try {
    const { data: act } = await supabase
      .from("activist_analysis_cache")
      .select("result")
      .eq("ticker", upperTicker)
      .maybeSingle();
    actResult = (act?.result as ActivistAnalysisResult) ?? null;
  } catch {
    // degrade gracefully
  }

  // 6. Risk flags cache
  let rfResult: RiskFlagResult | null = null;
  try {
    const { data: rf } = await supabase
      .from("risk_flag_cache")
      .select("result")
      .eq("ticker", upperTicker)
      .maybeSingle();
    rfResult = (rf?.result as RiskFlagResult) ?? null;
  } catch {
    // degrade gracefully
  }

  // Build context string
  const shortPercentOfFloat = fundamentals?.shortPercentOfFloat ?? null;
  const revenueGrowth = fundamentals?.revenueGrowth ?? null;
  const grossMargins = fundamentals?.grossMargins ?? null;
  const trailingPE = fundamentals?.trailingPE ?? null;
  const debtToEquity = fundamentals?.debtToEquity ?? null;

  const contextString = `TICKER: ${upperTicker}
COMPANY: ${companyName}
ANALYSIS DATE: ${new Date().toISOString().slice(0, 10)}

=== INSIDER TRANSACTION SIGNAL ===
Recent buy transactions (last 90 days): ${insiderTxnCount}
Total buy value: $${insiderBuyValue.toLocaleString()}
Unique buyers: ${uniqueBuyerCount}
Composite Conviction Score: ${compTotal != null ? compTotal + "/100" : "Not computed"}
Score breakdown: Insider=${breakdown?.insiderConvictionScore ?? "N/A"}pts, Fundamentals=${breakdown?.fundamentalsScore ?? "N/A"}pts, Valuation=${breakdown?.valuationScore ?? "N/A"}pts, Catalyst=${breakdown?.catalystScore ?? "N/A"}pts
Score rationale: ${rationale ?? "Data not available"}
Short interest (% of float): ${shortPercentOfFloat != null ? (shortPercentOfFloat * 100).toFixed(1) + "%" : "Data not available"}

=== EARNINGS SENTIMENT ===
Direction: ${sentResult?.sentimentDelta ?? "Data not available"}
Period compared: ${sentResult?.quarterCompared ?? "Data not available"}
Key theme changes:
${sentResult?.keyThemeChanges?.length ? sentResult.keyThemeChanges.map((s) => `- ${s}`).join("\n") : "- Data not available"}
Red flags:
${sentResult?.redFlags?.length ? sentResult.redFlags.map((s) => `- ${s}`).join("\n") : "- None identified"}
Confidence signals:
${sentResult?.confidenceSignals?.length ? sentResult.confidenceSignals.map((s) => `- ${s}`).join("\n") : "- None identified"}

=== ACTIVIST ACTIVITY ===
Active 13D filers: ${actResult?.filerCount ?? "None"}
Aggregate beneficial ownership disclosed: ${actResult?.totalPercentDisclosed != null ? actResult.totalPercentDisclosed + "%" : "N/A"}
Thesis category: ${actResult?.thesisCategory ?? "N/A"}
Specific demands:
${actResult?.specificDemands?.length ? actResult.specificDemands.map((s) => `- ${s}`).join("\n") : "- None identified"}
Tone: ${actResult?.tone ?? "N/A"}
Catalyst risk: ${actResult?.catalystRisk ?? "N/A"}

=== RISK FLAGS ===
Overall risk level: ${rfResult?.overallRiskLevel ?? "Not scanned"}
Flags identified (${rfResult?.flags?.length ?? 0} total, ${rfResult?.flags?.filter((f) => f.severity === "high").length ?? 0} high severity):
${rfResult?.flags?.length ? rfResult.flags.map((f) => `- [${f.severity.toUpperCase()}] ${f.category}: ${f.evidence}`).join("\n") : "- No material risk flags detected"}

=== FUNDAMENTALS SNAPSHOT ===
Revenue growth (YoY): ${revenueGrowth != null ? (revenueGrowth * 100).toFixed(1) + "%" : "N/A"}
Gross margins: ${grossMargins != null ? (grossMargins * 100).toFixed(1) + "%" : "N/A"}
Trailing P/E: ${trailingPE != null ? trailingPE.toFixed(1) : "N/A"}
Debt/equity: ${debtToEquity != null ? debtToEquity.toFixed(2) : "N/A"}`;

  const signalSummary: AIRecommendation["signalSummary"] = {
    compositeScore: compTotal,
    insiderTxnCount,
    insiderBuyValue,
    earningsSentiment: sentResult?.sentimentDelta ?? null,
    activistPresent: (actResult?.filerCount ?? 0) > 0,
    riskFlagCount: rfResult?.flags?.length ?? 0,
    highSeverityFlagCount:
      rfResult?.flags?.filter((f) => f.severity === "high").length ?? 0,
  };

  return { contextString, signalSummary, companyName };
}

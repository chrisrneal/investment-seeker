import { scoreSignal } from "./scoreSignal";
import { fetchFundamentals } from "./fundamentals";
import type {
  CompositeScore,
  CompositeScoreBreakdown,
  FundamentalsSnapshot,
  ParsedForm4Transaction,
} from "./types";

/**
 * Compute a Composite Conviction Score (0–100) combining the Insider
 * Conviction Score with fundamentals, valuation, and catalyst signals.
 *
 * Scoring:
 *  - insiderConvictionScore (0–40): ICS × 0.40
 *  - fundamentalsScore     (0–25): revenue growth + gross margins + D/E
 *  - valuationScore        (0–20): trailing P/E bands
 *  - catalystScore         (0–15): short squeeze setup + activist bonus
 */
export async function computeCompositeScore(
  ticker: string,
  transactions: ParsedForm4Transaction[],
  thirteenDGCount = 0
): Promise<CompositeScore> {
  const tickerUpper = ticker.toUpperCase();

  // Run ICS scoring and extended fundamentals fetch in parallel.
  const [insiderSignal, extFundamentals] = await Promise.all([
    scoreSignal(tickerUpper, transactions),
    fetchFundamentals(tickerUpper),
  ]);

  // Prefer extended fundamentals for display; fall back to ICS fundamentals.
  const fund: FundamentalsSnapshot =
    extFundamentals ?? insiderSignal.fundamentals ?? {
      trailingPE: null,
      revenueGrowth: null,
      grossMargins: null,
      totalCash: null,
      debtToEquity: null,
      fetchedAt: new Date().toISOString(),
    };

  const ics = insiderSignal.score;

  // ── insiderConvictionScore (0–40) ──────────────────────────────────
  const insiderConvictionScore = Math.round(ics * 0.4);

  // ── fundamentalsScore (0–25) ───────────────────────────────────────
  let fundamentalsScore = 0;

  const revenueGrowth = fund.revenueGrowth ?? insiderSignal.fundamentals?.revenueGrowth ?? null;
  if (revenueGrowth != null) {
    if (revenueGrowth > 0.15) fundamentalsScore += 8;
    else if (revenueGrowth > 0.05) fundamentalsScore += 5;
    else if (revenueGrowth >= 0) fundamentalsScore += 2;
  }

  const grossMargins = fund.grossMargins ?? insiderSignal.fundamentals?.grossMargins ?? null;
  if (grossMargins != null) {
    if (grossMargins > 0.5) fundamentalsScore += 9;
    else if (grossMargins > 0.3) fundamentalsScore += 6;
    else if (grossMargins > 0.15) fundamentalsScore += 3;
  }

  const debtToEquity = fund.debtToEquity ?? insiderSignal.fundamentals?.debtToEquity ?? null;
  if (debtToEquity != null) {
    if (debtToEquity < 0.5) fundamentalsScore += 8;
    else if (debtToEquity <= 1.5) fundamentalsScore += 5;
    else if (debtToEquity <= 3) fundamentalsScore += 2;
  }

  // ── valuationScore (0–20) ──────────────────────────────────────────
  const trailingPE = fund.trailingPE ?? insiderSignal.fundamentals?.trailingPE ?? null;
  let valuationScore: number;
  if (trailingPE == null || trailingPE <= 0) {
    valuationScore = 3;
  } else if (trailingPE >= 8 && trailingPE <= 15) {
    valuationScore = 20;
  } else if (trailingPE > 15 && trailingPE <= 22) {
    valuationScore = 15;
  } else if (trailingPE > 22 && trailingPE <= 35) {
    valuationScore = 8;
  } else {
    valuationScore = 3;
  }

  // ── catalystScore (0–15) ───────────────────────────────────────────
  const shortFloat =
    (fund.shortPercentOfFloat ?? null) ??
    insiderSignal.shortInterest?.shortPercentOfFloat ??
    null;

  let catalystScore = 0;
  if (shortFloat != null) {
    if (shortFloat > 0.2 && insiderConvictionScore > 20) {
      catalystScore = 15;
    } else if (shortFloat > 0.1 && insiderConvictionScore > 15) {
      catalystScore = 10;
    } else if (shortFloat >= 0.05) {
      catalystScore = 5;
    }
  }
  if (thirteenDGCount >= 1) {
    catalystScore = Math.min(15, catalystScore + 5);
  }

  const breakdown: CompositeScoreBreakdown = {
    insiderConvictionScore,
    fundamentalsScore,
    valuationScore,
    catalystScore,
  };

  const total = Math.min(
    100,
    insiderConvictionScore + fundamentalsScore + valuationScore + catalystScore
  );

  const rationale = buildRationale(
    total,
    ics,
    insiderConvictionScore,
    fundamentalsScore,
    valuationScore,
    catalystScore,
    fund,
    shortFloat,
    thirteenDGCount
  );

  return {
    ticker: tickerUpper,
    total,
    breakdown,
    fundamentals: fund,
    insiderSignal,
    rationale,
    computedAt: new Date().toISOString(),
  };
}

function buildRationale(
  total: number,
  ics: number,
  insiderPts: number,
  fundPts: number,
  valuePts: number,
  catalystPts: number,
  fund: FundamentalsSnapshot,
  shortFloat: number | null,
  thirteenDGCount: number
): string {
  const scored = [
    { label: "Insider conviction", pts: insiderPts, max: 40 },
    { label: "Fundamentals", pts: fundPts, max: 25 },
    { label: "Valuation", pts: valuePts, max: 20 },
    { label: "Catalyst setup", pts: catalystPts, max: 15 },
  ].sort((a, b) => b.pts / b.max - a.pts / a.max);

  const details: string[] = [];

  for (const s of scored.slice(0, 3)) {
    if (s.pts === 0) continue;
    if (s.label === "Insider conviction") {
      details.push(`ICS ${ics}/100 → ${insiderPts}/40 pts`);
    } else if (s.label === "Fundamentals") {
      const parts: string[] = [];
      if (fund.revenueGrowth != null && fund.revenueGrowth > 0.05)
        parts.push(`${(fund.revenueGrowth * 100).toFixed(0)}% rev growth`);
      if (fund.grossMargins != null && fund.grossMargins > 0.3)
        parts.push(`${(fund.grossMargins * 100).toFixed(0)}% gross margin`);
      details.push(
        parts.length > 0
          ? `Strong fundamentals (${parts.join(", ")})`
          : "Moderate fundamentals"
      );
    } else if (s.label === "Valuation") {
      if (fund.trailingPE != null && fund.trailingPE > 0)
        details.push(`P/E of ${fund.trailingPE.toFixed(1)}`);
    } else if (s.label === "Catalyst setup") {
      const parts: string[] = [];
      if (shortFloat != null && shortFloat > 0.1)
        parts.push(`${(shortFloat * 100).toFixed(1)}% short float`);
      if (thirteenDGCount > 0)
        parts.push(`${thirteenDGCount} activist filer(s)`);
      if (parts.length > 0) details.push(parts.join(", "));
    }
  }

  const label =
    total >= 75
      ? "Strong composite signal"
      : total >= 50
        ? "Moderate composite signal"
        : total >= 25
          ? "Weak composite signal"
          : "Minimal composite signal";

  return `${label} (${total}/100). ${details.join(". ")}${details.length ? "." : ""}`;
}

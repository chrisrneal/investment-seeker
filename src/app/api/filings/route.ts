import { NextRequest, NextResponse } from "next/server";
import { searchFilings } from "@/lib/sec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Supported filing types. We normalize common aliases to EDGAR form codes.
const FORM_ALIASES: Record<string, string> = {
  "3": "3",
  "form3": "3",
  "4": "4",
  "form4": "4",
  "5": "5",
  "form5": "5",
  "8-k": "8-K",
  "8k": "8-K",
  "form8-k": "8-K",
  "13f": "13F-HR",
  "13f-hr": "13F-HR",
  "13f-nt": "13F-NT",
};

function normalizeForm(input: string): string | null {
  const key = input.trim().toLowerCase();
  return FORM_ALIASES[key] ?? null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const typeRaw = searchParams.get("type");
  const ticker = searchParams.get("ticker")?.trim().toUpperCase() || undefined;
  const limitRaw = searchParams.get("limit");

  if (!typeRaw) {
    return NextResponse.json(
      {
        error:
          "Missing required query param 'type'. Use one of: 4, 8-K, 13F.",
      },
      { status: 400 }
    );
  }

  const formType = normalizeForm(typeRaw);
  if (!formType) {
    return NextResponse.json(
      {
        error: `Unsupported filing type '${typeRaw}'. Supported: 4, 8-K, 13F.`,
      },
      { status: 400 }
    );
  }

  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1),
    100
  );

  try {
    const { results, total } = await searchFilings({ formType, ticker, pageSize: limit });
    return NextResponse.json(
      {
        query: { type: formType, ticker: ticker ?? null, limit },
        count: results.length,
        total,
        results,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "EDGAR fetch failed", detail: message },
      { status: 502 }
    );
  }
}

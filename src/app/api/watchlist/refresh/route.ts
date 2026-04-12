import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * POST /api/watchlist/refresh — refresh scores from composite_score_cache
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const supabase = getSupabaseClient();

  // Get total count
  const { count: totalCount } = await supabase
    .from("watchlist")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

  // Get entries (limit 10 to stay within timeout)
  const { data: entries, error } = await supabase
    .from("watchlist")
    .select("*")
    .eq("user_id", user.id)
    .limit(10);

  if (error) {
    return errorJson("Failed to fetch watchlist", error.message, 500);
  }

  if (!entries || entries.length === 0) {
    return NextResponse.json({ refreshed: 0, skipped: 0, entries: [] });
  }

  const skipped = (totalCount ?? 0) - entries.length;
  const results: { ticker: string; currentScore: number | null; alertTriggered: boolean }[] = [];

  for (const entry of entries) {
    type CacheRow = { total: number };
    const { data: cached } = await supabase
      .from("composite_score_cache")
      .select("total")
      .eq("ticker", entry.ticker.toUpperCase())
      .maybeSingle() as { data: CacheRow | null; error: unknown };

    const currentScore = cached?.total ?? null;
    const alertTriggered = currentScore != null
      ? currentScore >= entry.alert_threshold
      : false;

    await supabase
      .from("watchlist")
      .update({
        current_score: currentScore,
        alert_triggered: alertTriggered,
        last_checked_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("ticker", entry.ticker);

    results.push({
      ticker: entry.ticker,
      currentScore,
      alertTriggered,
    });
  }

  return NextResponse.json({
    refreshed: entries.length,
    skipped,
    entries: results,
  });
}

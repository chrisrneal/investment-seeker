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
 * GET /api/watchlist — list user's watchlist, ordered by score desc
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .eq("user_id", user.id)
    .order("current_score", { ascending: false, nullsFirst: false });

  if (error) {
    return errorJson("Failed to fetch watchlist", error.message, 500);
  }

  return NextResponse.json(data ?? []);
}

/**
 * POST /api/watchlist — add a ticker to the user's watchlist
 * Body: { ticker: string, alertThreshold?: number }
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const body = await req.json().catch(() => ({}));
  const rawTicker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";

  if (!rawTicker || rawTicker.length > 10 || !/^[A-Z0-9.]+$/.test(rawTicker)) {
    return errorJson("Invalid ticker", "Ticker must be 1–10 alphanumeric characters", 400);
  }

  const alertThreshold =
    typeof body.alertThreshold === "number"
      ? Math.max(0, Math.min(100, Math.round(body.alertThreshold)))
      : 70;

  const supabase = getSupabaseClient();

  // Look up company name
  const { data: co } = await supabase
    .from("companies")
    .select("name")
    .ilike("ticker", rawTicker)
    .maybeSingle() as { data: { name: string } | null; error: unknown };

  const companyName = co?.name ?? rawTicker;

  const { data: inserted, error } = await supabase
    .from("watchlist")
    .insert({
      user_id: user.id,
      ticker: rawTicker,
      company_name: companyName,
      alert_threshold: alertThreshold,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return errorJson("Ticker already in watchlist", undefined, 409);
    }
    return errorJson("Failed to add to watchlist", error.message, 500);
  }

  return NextResponse.json(inserted, { status: 201 });
}

/**
 * DELETE /api/watchlist?ticker=TICKER — remove a ticker from watchlist
 */
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return errorJson("Missing 'ticker' query param", undefined, 400);
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("watchlist")
    .delete()
    .eq("user_id", user.id)
    .eq("ticker", ticker)
    .select("id");

  if (error) {
    return errorJson("Failed to delete", error.message, 500);
  }

  if (!data || data.length === 0) {
    return errorJson("Ticker not found in watchlist", undefined, 404);
  }

  return NextResponse.json({ deleted: true });
}

/**
 * PATCH /api/watchlist?ticker=TICKER — update alert threshold
 * Body: { alertThreshold: number }
 */
export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return errorJson("Missing 'ticker' query param", undefined, 400);
  }

  const body = await req.json().catch(() => ({}));
  const alertThreshold = typeof body.alertThreshold === "number" ? body.alertThreshold : null;

  if (alertThreshold == null || alertThreshold < 0 || alertThreshold > 100) {
    return errorJson("alertThreshold must be 0–100", undefined, 400);
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("watchlist")
    .update({ alert_threshold: Math.round(alertThreshold) })
    .eq("user_id", user.id)
    .eq("ticker", ticker)
    .select()
    .single();

  if (error) {
    return errorJson("Failed to update", error.message, 500);
  }

  if (!data) {
    return errorJson("Ticker not found in watchlist", undefined, 404);
  }

  return NextResponse.json(data);
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";

/**
 * Verify the request has a valid Supabase session via cookies.
 * Returns the authenticated user or null.
 */
export async function getAuthUser(req: NextRequest): Promise<User | null> {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only in API routes — session refresh handled by middleware if needed
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

/** Standard 401 JSON response for unauthenticated requests. */
export function unauthorizedResponse() {
  return NextResponse.json(
    { error: "Authentication required", detail: "Sign in to use AI features." },
    { status: 401 }
  );
}

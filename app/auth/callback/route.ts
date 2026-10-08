import { NextResponse } from "next/server";

import { logServerError } from "@/lib/server/errors";
import { safeNextPath } from "@/lib/server/validate";
import { createClient } from "@/utils/supabase/server";

/**
 * Magic-link landing. Supabase redirects here with a one-time PKCE `code`; the
 * matching verifier is in this browser's cookies, so a link opened in another
 * browser fails safely. On success the session cookies are set and the user
 * continues to `next` (same-origin paths only).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    logServerError("auth/callback", error);
  }

  const login = new URL("/login", url.origin);
  login.searchParams.set("error", "link");
  login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

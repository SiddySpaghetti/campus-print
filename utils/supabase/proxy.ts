import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Refreshes the Supabase auth session on every matched request and writes the
 * refreshed cookies onto both the request (so Server Components see them) and
 * the response (so the browser stores them).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Same checks as utils/supabase/server.ts: name the missing var instead of
  // letting undefined reach @supabase/ssr's generic "URL and Key are required".
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");
  if (!key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY.");

  const supabase = createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Validates the token and triggers a refresh when it is close to expiry.
  // Don't put logic between createServerClient and this call.
  await supabase.auth.getClaims();

  return response;
}

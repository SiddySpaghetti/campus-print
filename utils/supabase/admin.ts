import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { HttpError, SAFE } from "@/lib/server/errors";

/**
 * Service-role Supabase client. It BYPASSES row level security, so:
 *  - import it only from Route Handlers / Server Actions, never from a
 *    component that can run in the browser;
 *  - only use it after the caller has been authenticated and authorised with
 *    `requireUser()` / `requireRole()` in lib/server/auth.ts;
 *  - the key lives in SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix, so
 *    Next.js never inlines it into client bundles).
 */
export function createAdminClient() {
  if (typeof window !== "undefined") {
    throw new Error("createAdminClient() must never run in the browser");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // Safe, generic message for the caller; the route logs the real cause.
    throw new HttpError(
      SAFE.notConfigured.status,
      SAFE.notConfigured.code,
      "SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL is not configured",
    );
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

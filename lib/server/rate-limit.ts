/**
 * Route-level rate limiting backed by Postgres (public.check_rate_limit), so it
 * is atomic across serverless instances with no extra service. Windows use
 * database time; callers never supply a timestamp.
 *
 * Keys: authenticated routes limit by USER ID (not spoofable); anonymous ones
 * (webhook failures) by a hash of the client IP.
 */
import { createHash } from "node:crypto";

import { createAdminClient } from "@/utils/supabase/admin";

import { errorResponse, logServerError, SAFE } from "./errors";

/** First hop of x-forwarded-for (set by Vercel's edge, not the client, there). */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 24);
}

/** Returns a 429 Response when over the limit, otherwise null. Fails closed. */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("check_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    if (data === true) return null;
    return errorResponse(SAFE.rateLimited, { "Retry-After": String(windowSeconds) });
  } catch (error) {
    logServerError("rate-limit", error);
    return errorResponse(SAFE.notConfigured);
  }
}

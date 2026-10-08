/**
 * Server-side authentication + authorisation. THE pattern for every protected
 * Route Handler / Server Action (admin ones especially):
 *
 *   const { user, role } = await requireRole("admin");   // throws HttpError
 *
 * Rules this enforces:
 *  - identity comes from `supabase.auth.getUser()`, which re-validates the
 *    token with Supabase Auth. `getSession()` / cookies / headers / request
 *    bodies are never believed;
 *  - the role is read from `public.profiles` (a table users cannot write their
 *    own role to — see profiles_guard), never from the browser or JWT metadata;
 *  - a soft-deleted profile has no role;
 *  - hiding a button, or proxy.ts, is NOT authorisation. Call this in the
 *    handler itself, before doing anything else.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

import { HttpError, SAFE } from "./errors";

export type AppRole = "student" | "shopkeeper" | "admin";

export type AuthContext = {
  /** Supabase client acting AS the signed-in user (RLS applies). */
  supabase: SupabaseClient;
  user: User;
  role: AppRole;
  /** Set only for shopkeepers. */
  shopId: string | null;
};

export async function requireUser(): Promise<Pick<AuthContext, "supabase" | "user">> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(SAFE.unauthenticated.status, SAFE.unauthenticated.code, SAFE.unauthenticated.message);
  }
  return { supabase, user: data.user };
}

export async function requireRole(...allowed: AppRole[]): Promise<AuthContext> {
  const { supabase, user } = await requireUser();

  // RLS lets a user read exactly their own profile row.
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role, shop_id, deleted_at")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !profile || profile.deleted_at) {
    throw new HttpError(SAFE.forbidden.status, SAFE.forbidden.code, SAFE.forbidden.message);
  }
  const role = profile.role as AppRole;
  if (!allowed.includes(role)) {
    throw new HttpError(SAFE.forbidden.status, SAFE.forbidden.code, SAFE.forbidden.message);
  }
  return { supabase, user, role, shopId: role === "shopkeeper" ? profile.shop_id : null };
}

export const requireAdmin = () => requireRole("admin");

/** Where each role lands after signing in (or on a page meant for another role). */
export const ROLE_HOME: Record<AppRole, string> = {
  student: "/start-printing",
  shopkeeper: "/shop",
  admin: "/admin",
};

/**
 * For Server Component PAGES. Signed-out visitors go to /login; signed-in
 * users with another role go to their own home, since every API of this area
 * would refuse them anyway. Pages must call this themselves: a layout's check
 * is not enough, because layouts and pages render in parallel. `cache` makes
 * the layout + page share one lookup per request.
 */
export const requireRolePage = cache(async (role: AppRole, next: string) => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/login?next=${encodeURIComponent(next)}`);

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, shop_id, deleted_at")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile || profile.deleted_at) redirect("/");
  if (profile.role !== role) redirect(ROLE_HOME[profile.role as AppRole] ?? "/");

  return { supabase, user: data.user, shopId: profile.shop_id as string | null };
});

export const requireStudentPage = (next: string) => requireRolePage("student", next);

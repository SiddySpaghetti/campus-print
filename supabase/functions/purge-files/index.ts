// Purges stored print files. Invoked on a schedule (see README note below).
//
//  1. Files of orders that reached COMPLETED / CANCELLED / REJECTED at least 7
//     days ago (public.files_due_for_purge) -> deleted through the Storage API,
//     then recorded with public.mark_files_purged (file_deleted_at,
//     orders.files_purged_at).
//  2. Uploads older than 24 h that never became part of any order
//     (public.orphan_uploads) -> deleted through the Storage API.
//
// Safe to run repeatedly (idempotent) and concurrently-ish: removing an already
// removed object is a no-op, and the SQL functions only ever select files of
// orders in a FINAL state past their purge date, so active orders are untouched.
//
// Auth: the caller must present the project's service-role key as the Bearer
// token (verify_jwt is also on). The key is read from the function's own
// environment (SUPABASE_SERVICE_ROLE_KEY, injected by Supabase) and is never
// returned or logged.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BATCH = 100;

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return new Response("unavailable", { status: 503 });

  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (req.method !== "POST" || !timingSafeEqual(bearer, serviceKey)) {
    return new Response("forbidden", { status: 403 });
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = admin.storage.from("print-files");
  const result = { purgedFiles: 0, orphansDeleted: 0, errors: 0 };

  // 1. Files of finished orders past the retention period.
  const { data: due, error: dueError } = await admin.rpc("files_due_for_purge", { p_limit: BATCH });
  if (dueError) {
    console.error("[purge-files] files_due_for_purge failed", dueError.code);
    result.errors++;
  } else if (due && due.length > 0) {
    const { error: removeError } = await bucket.remove(due.map((f: { storage_path: string }) => f.storage_path));
    if (removeError) {
      console.error("[purge-files] storage remove failed");
      result.errors++;
    } else {
      const { data: marked, error: markError } = await admin.rpc("mark_files_purged", {
        p_file_ids: due.map((f: { file_id: string }) => f.file_id),
      });
      if (markError) {
        console.error("[purge-files] mark_files_purged failed", markError.code);
        result.errors++;
      } else {
        result.purgedFiles = Number(marked ?? 0);
      }
    }
  }

  // 2. Orphan uploads (never attached to an order) older than 24 hours.
  const { data: orphans, error: orphanError } = await admin.rpc("orphan_uploads", {
    p_older_than: "24 hours",
    p_limit: BATCH,
  });
  if (orphanError) {
    console.error("[purge-files] orphan_uploads failed", orphanError.code);
    result.errors++;
  } else if (orphans && orphans.length > 0) {
    const { error: removeError } = await bucket.remove(orphans.map((o: { storage_path: string }) => o.storage_path));
    if (removeError) {
      console.error("[purge-files] orphan remove failed");
      result.errors++;
    } else {
      result.orphansDeleted = orphans.length;
    }
  }

  return Response.json(result, { status: result.errors ? 500 : 200 });
});

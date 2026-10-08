import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";

/**
 * Mark all of the signed-in student's notifications as read. Runs AS the user:
 * RLS (notifications_update_own) limits it to their own rows and
 * notifications_guard allows only read_at to change.
 */
export function POST() {
  return handle("api/notifications/read", async () => {
    const { supabase, user } = await requireRole("student");

    const limited = await rateLimit(`notifications_read:${user.id}`, 60, 600);
    if (limited) return limited;

    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    if (error) {
      logServerError("api/notifications/read", error);
      return errorResponse(SAFE.internal);
    }
    return Response.json({ ok: true });
  });
}

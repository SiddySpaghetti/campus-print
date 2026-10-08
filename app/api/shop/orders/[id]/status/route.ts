import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, readJson, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseStatusChange, parseUuidParam, SHOP_TRANSITIONS } from "@/lib/server/validate";

/**
 * Move one of the signed-in shopkeeper's orders along its lifecycle.
 *
 * Runs AS the shopkeeper (never the service role), so the database decides:
 * RLS (orders_update_shop) limits it to their own shop's visible orders,
 * orders_guard allows only status/status_reason to change (never price or
 * payment), and orders_lifecycle allows only legal moves. The `.in("status",
 * from)` makes it a compare-and-set: a double click or a stale tab updates
 * nothing instead of firing a second transition.
 */
export function POST(request: Request, ctx: RouteContext<"/api/shop/orders/[id]/status">) {
  return handle("api/shop/orders/status", async () => {
    const { supabase, user } = await requireRole("shopkeeper");
    const orderId = parseUuidParam((await ctx.params).id);

    const limited = await rateLimit(`shop_status:${user.id}`, 300, 600);
    if (limited) return limited;

    const { status, reason } = parseStatusChange(await readJson(request, 2_000));
    const patch = reason ? { status, status_reason: reason } : { status };

    const { data, error } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", orderId)
      .in("status", [...SHOP_TRANSITIONS[status]])
      .select("id, status")
      .maybeSingle();
    if (error) {
      logServerError("api/shop/orders/status", error);
      return errorResponse(mapDbError(error, SAFE.statusFailed));
    }
    if (!data) return errorResponse(SAFE.statusFailed);
    return Response.json({ order: data });
  });
}

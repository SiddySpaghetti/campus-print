import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, SAFE } from "@/lib/server/errors";
import { parseUuidParam } from "@/lib/server/validate";

/**
 * Cancel the signed-in student's own PENDING order. Runs as the USER (not the
 * service role), so cancel_order's own checks (ownership via auth.uid(),
 * PENDING only, rate limit) are what decide — not this route.
 */
export function POST(_request: Request, ctx: RouteContext<"/api/orders/[id]/cancel">) {
  return handle("api/orders/cancel", async () => {
    const { supabase } = await requireRole("student");
    const orderId = parseUuidParam((await ctx.params).id);

    const { data, error } = await supabase.rpc("cancel_order", { p_order_id: orderId });
    if (error || !data) {
      logServerError("api/orders/cancel", error);
      return errorResponse(mapDbError(error ?? {}, SAFE.cancelFailed));
    }
    const order = data as { id: string; status: string; payment_status: string };
    return Response.json({
      order: { id: order.id, status: order.status, paymentStatus: order.payment_status },
    });
  });
}

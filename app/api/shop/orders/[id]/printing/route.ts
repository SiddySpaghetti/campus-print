import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUuidParam } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * The shopkeeper's "Printing started": the only thing that moves an order to
 * PRINTING and tells the student. A browser can't see the printer, so this is a
 * person's confirmation, never a side effect of the print dialog opening.
 *
 * confirm_printing is a compare-and-set pinned to this shop, needs a recorded
 * print request, and the lifecycle trigger still refuses an unpaid online order.
 * A repeat, or an order cancelled in the meantime, updates nothing and answers
 * 409 so the shop knows to stop.
 */
export function POST(_request: Request, ctx: RouteContext<"/api/shop/orders/[id]/printing">) {
  return handle("api/shop/orders/printing", async () => {
    const { user, shopId } = await requireRole("shopkeeper");
    const orderId = parseUuidParam((await ctx.params).id);

    const limited = await rateLimit(`shop_printing:${user.id}`, 120, 600);
    if (limited) return limited;

    const { data: started, error } = await createAdminClient().rpc("confirm_printing", {
      p_order_id: orderId,
      p_shop_id: shopId,
    });
    if (error) {
      logServerError("api/shop/orders/printing", error);
      return errorResponse(mapDbError(error, SAFE.printNotConfirmed));
    }
    if (started !== true) return errorResponse(SAFE.printNotConfirmed);
    return Response.json({ ok: true });
  });
}

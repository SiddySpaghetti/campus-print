import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUuidParam } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Start a Razorpay payment for the signed-in student's own order.
 *
 * Required environment (server only; names only here, never values):
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 * Until they are configured this route answers 503 and creates nothing.
 *
 * The amount is NEVER taken from the request: it is `orders.total_paise`, read
 * from the database after confirming the order is the caller's own, PENDING and
 * unpaid. The browser cannot influence amount, currency or order.
 *
 * PAID is never set here. Only the signature-verified webhook marks an order
 * paid; the browser's "payment succeeded" callback is just a hint to refresh.
 */
export function POST(_request: Request, ctx: RouteContext<"/api/orders/[id]/payment">) {
  return handle("api/orders/payment", async () => {
    const { supabase, user } = await requireRole("student");
    const orderId = parseUuidParam((await ctx.params).id);

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      logServerError("api/orders/payment", new Error("Razorpay credentials are not configured"));
      return errorResponse(SAFE.notConfigured);
    }

    const limited = await rateLimit(`pay:${user.id}`, 10, 600);
    if (limited) return limited;

    // Read through RLS as the user: only their own order can come back.
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, status, payment_method, payment_status, total_paise, payment_order_id")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !order) return errorResponse(SAFE.payFailed);
    if (order.payment_method !== "ONLINE" || order.status !== "PENDING" || !["PENDING", "FAILED"].includes(order.payment_status)) {
      return errorResponse(SAFE.payFailed);
    }

    // Already created (double click / retry): hand back the same gateway order.
    if (order.payment_order_id) {
      return Response.json({
        keyId,
        razorpayOrderId: order.payment_order_id,
        amountPaise: order.total_paise,
        currency: "INR",
      });
    }

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      },
      // Amount, currency and receipt all come from OUR database row.
      body: JSON.stringify({ amount: order.total_paise, currency: "INR", receipt: order.id }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => {
      logServerError("api/orders/payment:gateway", e);
      return null;
    });
    if (!response?.ok) {
      if (response) logServerError("api/orders/payment:gateway", new Error(`gateway status ${response.status}`));
      return errorResponse(SAFE.payFailed);
    }
    const gateway = (await response.json()) as { id?: unknown; amount?: unknown; currency?: unknown };
    if (
      typeof gateway.id !== "string" ||
      gateway.amount !== order.total_paise ||
      gateway.currency !== "INR"
    ) {
      logServerError("api/orders/payment:gateway", new Error("unexpected gateway response"));
      return errorResponse(SAFE.payFailed);
    }

    const admin = createAdminClient();
    const { data: attached, error: attachError } = await admin.rpc("attach_payment_order", {
      p_order_id: order.id,
      p_user_id: user.id,
      p_payment_order_id: gateway.id,
    });
    if (attachError || !attached) {
      logServerError("api/orders/payment:attach", attachError);
      return errorResponse(mapDbError(attachError ?? {}, SAFE.payFailed));
    }

    // If a concurrent request attached first, the stored id is the one to use.
    const stored = attached as { payment_order_id: string; total_paise: number };
    return Response.json({
      keyId,
      razorpayOrderId: stored.payment_order_id,
      amountPaise: stored.total_paise,
      currency: "INR",
    });
  });
}


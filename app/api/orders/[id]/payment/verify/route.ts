import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, readJson, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { shopAllowsOnlinePayment, verifyCheckoutSignature } from "@/lib/server/razorpay";
import { parseUuidParam } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{6,40}$/;

/**
 * Called by Razorpay Checkout's success handler with
 * { razorpay_payment_id, razorpay_signature }. The handler alone proves nothing,
 * so before anything changes:
 *
 *  1. the order must be the caller's own ONLINE order of the enabled shop, with
 *     a gateway order attached by POST /payment;
 *  2. razorpay_signature must match HMAC(<OUR stored order id>|payment id);
 *  3. the payment is fetched from Razorpay server-to-server and must be
 *     `captured`, for OUR gateway order, in INR, for exactly orders.total_paise.
 *
 * Only then is it handed to process_payment_event (the same idempotent function
 * the webhook uses; it re-checks amount and currency and dedupes by event id).
 * A payment that is only `authorized` is left for the webhook. Answers
 * { status: "paid" | "pending" }.
 */
export function POST(request: Request, ctx: RouteContext<"/api/orders/[id]/payment/verify">) {
  return handle("api/orders/payment/verify", async () => {
    const { supabase, user } = await requireRole("student");
    const orderId = parseUuidParam((await ctx.params).id);

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return errorResponse(SAFE.notConfigured);

    const limited = await rateLimit(`pay_verify:${user.id}`, 20, 600);
    if (limited) return limited;

    const body = (await readJson(request)) as Record<string, unknown> | null;
    const paymentId = body?.razorpay_payment_id;
    const signature = body?.razorpay_signature;
    if (typeof paymentId !== "string" || !PAYMENT_ID_RE.test(paymentId) || typeof signature !== "string") {
      return errorResponse(SAFE.badRequest);
    }

    // Through RLS as the user: only their own order can come back.
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, shop_id, payment_method, payment_status, total_paise, payment_order_id")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !order || order.payment_method !== "ONLINE" || !order.payment_order_id) {
      return errorResponse(SAFE.badRequest);
    }
    if (order.payment_status === "PAID") return Response.json({ status: "paid" });

    const admin = createAdminClient();
    if (!(await shopAllowsOnlinePayment(admin, order.shop_id))) return errorResponse(SAFE.forbidden);

    if (!verifyCheckoutSignature(order.payment_order_id, paymentId, signature, keySecret)) {
      return errorResponse(SAFE.badRequest);
    }

    const response = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => {
      logServerError("api/orders/payment/verify:gateway", e);
      return null;
    });
    // Gateway unreachable: the signature was fine, so let the webhook finish it.
    if (!response?.ok) return Response.json({ status: "pending" });

    const payment = (await response.json()) as {
      id?: unknown;
      order_id?: unknown;
      status?: unknown;
      amount?: unknown;
      currency?: unknown;
    };
    if (payment.id !== paymentId || payment.order_id !== order.payment_order_id) {
      logServerError("api/orders/payment/verify", new Error("payment does not belong to this order"));
      return errorResponse(SAFE.badRequest);
    }
    if (payment.status !== "captured") return Response.json({ status: "pending" });
    if (payment.currency !== "INR" || payment.amount !== order.total_paise) {
      logServerError("api/orders/payment/verify", new Error("amount or currency mismatch"));
      return errorResponse(SAFE.badRequest);
    }

    const { data: result, error: processError } = await admin.rpc("process_payment_event", {
      p_provider: "razorpay",
      p_event_id: `checkout:${paymentId}`,
      p_event_type: "payment.captured",
      p_payment_order_id: order.payment_order_id,
      p_payment_id: paymentId,
      p_amount_paise: payment.amount,
      p_currency: payment.currency,
      p_payload: {
        source: "checkout_verify",
        order_id: order.payment_order_id,
        payment_id: paymentId,
        amount: payment.amount,
        currency: payment.currency,
      },
    });
    if (processError) {
      logServerError("api/orders/payment/verify:process", processError);
      return Response.json({ status: "pending" }); // the webhook still delivers it
    }
    return Response.json({ status: result === "paid" ? "paid" : "pending" });
  });
}

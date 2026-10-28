import { errorResponse, handle, logServerError, SAFE } from "@/lib/server/errors";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";
import { HANDLED_EVENTS, parsePaymentEvent, razorpayAccounts, verifyWebhookSignature } from "@/lib/server/razorpay";
import { createAdminClient } from "@/utils/supabase/admin";

/** process_payment_event outcomes that need manual reconciliation. */
const NEEDS_A_HUMAN = new Set([
  "amount_mismatch",
  "unknown_order",
  "paid_after_cancel",
  "partially_refunded",
  "refund_on_paid_order",
  "refund_exceeds_total",
  "refund_unverified",
  "refund_amount_invalid",
  "refund_failed",
]);

/**
 * Razorpay webhook — the authoritative way an order becomes PAID (the checkout
 * verify route is a faster path into the same process_payment_event).
 *
 * Required environment (server only): each shop account's WEBHOOK_SECRET (see
 * lib/server/razorpay.ts). Every shop's Razorpay dashboard points here.
 *
 *  1. Read the RAW body (the signature is over exact bytes, so no re-serialising).
 *  2. Verify X-Razorpay-Signature (HMAC-SHA256, constant-time) against each
 *     account's secret. Bad signature -> 400 and nothing else happens. Only
 *     FAILED attempts count against a per-IP limit, so genuine Razorpay traffic
 *     is never throttled.
 *     The event's order must belong to the shop whose secret signed it: one
 *     shop's secret can never change another shop's order.
 *  3. Hand the event to process_payment_event, which in one transaction records
 *     it (unique provider+event id => replays are no-ops), checks currency and
 *     amount against OUR stored total, and applies only legal state changes.
 *  4. Answer 200 for anything we have handled or deliberately ignored; answer
 *     5xx only when our database failed, so Razorpay retries (safely, thanks
 *     to step 3).
 */
export function POST(request: Request) {
  return handle("api/webhook/razorpay", async () => {
    const accounts = razorpayAccounts().filter((a) => a.webhookSecret);
    if (accounts.length === 0) {
      logServerError("api/webhook/razorpay", new Error("no Razorpay webhook secret is configured"));
      return errorResponse(SAFE.notConfigured);
    }

    const rawBody = await request.text();
    if (rawBody.length > 100_000) return errorResponse(SAFE.badRequest);

    const signature = request.headers.get("x-razorpay-signature");
    const account = accounts.find((a) => verifyWebhookSignature(rawBody, signature, a.webhookSecret!));
    if (!account) {
      // The limiter is only abuse mitigation on this path, not a security gate:
      // if it is unavailable the answer is still a plain 400.
      const limited = await rateLimit(`webhook_bad_sig:${clientKey(request)}`, 30, 600);
      return limited?.status === 429 ? limited : errorResponse(SAFE.badRequest);
    }

    const eventId = request.headers.get("x-razorpay-event-id");
    if (!eventId || eventId.length > 100) return errorResponse(SAFE.badRequest);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse(SAFE.badRequest);
    }
    const event = parsePaymentEvent(body);
    if (!event) return errorResponse(SAFE.badRequest);
    // Signed, but not an event we act on (e.g. payment.authorized): acknowledge it
    // so Razorpay stops retrying. It carries no order ids, so reconciling it
    // could only log a false "unknown_order".
    if (!HANDLED_EVENTS.has(event.eventType)) return Response.json({ received: true });

    const admin = createAdminClient();

    // Same lookup process_payment_event uses. An order of another shop means
    // this account's secret is being used against it: refuse, change nothing.
    const [column, value] = event.paymentOrderId
      ? ["payment_order_id", event.paymentOrderId]
      : ["payment_id", event.paymentId];
    if (value) {
      const { data: owner, error: ownerError } = await admin
        .from("orders")
        .select("shop_id")
        .eq(column, value)
        .maybeSingle();
      if (ownerError) {
        logServerError("api/webhook/razorpay:owner", ownerError);
        return errorResponse(SAFE.internal);
      }
      if (owner && owner.shop_id !== account.shopId) {
        logServerError("api/webhook/razorpay", new Error("event signed by another shop's account"));
        return errorResponse(SAFE.badRequest);
      }
    }

    const { data, error } = await admin.rpc("process_payment_event", {
      p_provider: "razorpay",
      p_event_id: eventId,
      p_event_type: event.eventType,
      p_payment_order_id: event.paymentOrderId,
      p_payment_id: event.paymentId,
      p_amount_paise: event.amountPaise,
      p_currency: event.currency,
      p_payload: event.payload,
    });
    if (error) {
      logServerError("api/webhook/razorpay:process", error);
      return errorResponse(SAFE.internal); // 500 => Razorpay retries; processing is idempotent
    }
    if (NEEDS_A_HUMAN.has(String(data))) {
      // Worth a human look (docs/refund-reconciliation.md), but retrying would not help.
      logServerError("api/webhook/razorpay:event", new Error(`event ${String(data)}`));
    }
    return Response.json({ received: true });
  });
}

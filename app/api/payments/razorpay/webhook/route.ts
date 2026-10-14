import { errorResponse, handle, logServerError, SAFE } from "@/lib/server/errors";
import { clientKey, rateLimit } from "@/lib/server/rate-limit";
import { parsePaymentEvent, verifyWebhookSignature } from "@/lib/server/razorpay";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Razorpay webhook — the authoritative way an order becomes PAID (the checkout
 * verify route is a faster path into the same process_payment_event).
 *
 * Required environment (server only): RAZORPAY_WEBHOOK_SECRET.
 *
 *  1. Read the RAW body (the signature is over exact bytes, so no re-serialising).
 *  2. Verify X-Razorpay-Signature (HMAC-SHA256, constant-time). Bad signature ->
 *     400 and nothing else happens. Only FAILED attempts count against a per-IP
 *     limit, so genuine Razorpay traffic is never throttled.
 *  3. Hand the event to process_payment_event, which in one transaction records
 *     it (unique provider+event id => replays are no-ops), checks currency and
 *     amount against OUR stored total, and applies only legal state changes.
 *  4. Answer 200 for anything we have handled or deliberately ignored; answer
 *     5xx only when our database failed, so Razorpay retries (safely, thanks
 *     to step 3).
 */
export function POST(request: Request) {
  return handle("api/webhook/razorpay", async () => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      logServerError("api/webhook/razorpay", new Error("RAZORPAY_WEBHOOK_SECRET is not configured"));
      return errorResponse(SAFE.notConfigured);
    }

    const rawBody = await request.text();
    if (rawBody.length > 100_000) return errorResponse(SAFE.badRequest);

    const signature = request.headers.get("x-razorpay-signature");
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
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

    const admin = createAdminClient();
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
    if (data === "amount_mismatch" || data === "unknown_order") {
      // Worth a human look, but retrying would not help.
      logServerError("api/webhook/razorpay:event", new Error(`event ${String(data)}`));
    }
    return Response.json({ received: true });
  });
}

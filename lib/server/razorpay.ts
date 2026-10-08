/**
 * Razorpay helpers. Server-only: every credential comes from environment
 * variables and is never sent to the browser.
 *
 *   RAZORPAY_KEY_ID           public identifier (returned to checkout; not secret)
 *   RAZORPAY_KEY_SECRET       secret — server only
 *   RAZORPAY_WEBHOOK_SECRET   secret — server only, set in the Razorpay dashboard
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time check of Razorpay's `X-Razorpay-Signature` over the RAW body. */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  if (!/^[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(signatureHeader, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type ParsedPaymentEvent = {
  eventType: string;
  paymentOrderId: string | null;
  paymentId: string | null;
  amountPaise: number | null;
  currency: string | null;
  /** Minimal, PII-free record kept in payment_events.payload. */
  payload: Record<string, unknown>;
};

const HANDLED = new Set(["payment.captured", "payment.failed", "order.paid", "refund.processed"]);

/** Pulls only the fields we act on out of Razorpay's envelope. */
export function parsePaymentEvent(body: unknown): ParsedPaymentEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as {
    event?: unknown;
    payload?: Record<string, { entity?: Record<string, unknown> } | undefined>;
  };
  if (typeof b.event !== "string" || !HANDLED.has(b.event)) {
    return typeof b.event === "string"
      ? { eventType: b.event, paymentOrderId: null, paymentId: null, amountPaise: null, currency: null, payload: { event: b.event } }
      : null;
  }
  const pay = b.payload?.payment?.entity;
  const ord = b.payload?.order?.entity;
  const ref = b.payload?.refund?.entity;
  const str = (v: unknown) => (typeof v === "string" && v.length <= 100 ? v : null);
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : null);

  const paymentOrderId = str(pay?.order_id) ?? str(ord?.id);
  const paymentId = str(pay?.id) ?? str(ref?.payment_id);
  const amountPaise = int(pay?.amount) ?? int(ord?.amount_paid) ?? int(ref?.amount);
  const currency = str(pay?.currency) ?? str(ord?.currency) ?? str(ref?.currency);
  return {
    eventType: b.event,
    paymentOrderId,
    paymentId,
    amountPaise,
    currency,
    payload: { event: b.event, order_id: paymentOrderId, payment_id: paymentId, amount: amountPaise, currency },
  };
}

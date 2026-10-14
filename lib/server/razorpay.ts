/**
 * Razorpay helpers. Server-only: every credential comes from environment
 * variables and is never sent to the browser.
 *
 *   RAZORPAY_KEY_ID           public identifier (returned to checkout; not secret)
 *   RAZORPAY_KEY_SECRET       secret — server only
 *   RAZORPAY_WEBHOOK_SECRET   secret — server only, set in the Razorpay dashboard
 *   RAZORPAY_ENABLED_SHOP_ID  UUID of the ONE shop whose merchant account these
 *                             keys belong to (Sitaram Prints). Every other shop
 *                             is pay-at-counter only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUuid } from "@/lib/server/validate";

/** Constant-time HMAC-SHA256 hex comparison. */
function hmacMatches(message: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(message, "utf8").digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time check of Razorpay's `X-Razorpay-Signature` over the RAW body. */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  return hmacMatches(rawBody, signatureHeader, secret);
}

/**
 * Checkout's `razorpay_signature`: HMAC-SHA256 of `order_id|payment_id` with the
 * key secret. `storedOrderId` MUST be the gateway order id from OUR database,
 * never the one the browser sends back (Razorpay's documented rule).
 */
export function verifyCheckoutSignature(
  storedOrderId: string,
  paymentId: string,
  signature: string | null,
  secret: string,
): boolean {
  return hmacMatches(`${storedOrderId}|${paymentId}`, signature, secret);
}

/**
 * The single online-payment gate. True only when Razorpay is configured, the
 * shop IS the configured RAZORPAY_ENABLED_SHOP_ID, and its online_payment flag
 * is true. Anything missing or mismatched means pay-at-counter.
 */
export function onlinePaymentAllowed(
  shopId: string,
  onlinePaymentFlag: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const enabledShopId = env.RAZORPAY_ENABLED_SHOP_ID?.trim().toLowerCase();
  return (
    isUuid(enabledShopId) &&
    shopId === enabledShopId &&
    onlinePaymentFlag === true &&
    !!env.RAZORPAY_KEY_ID &&
    !!env.RAZORPAY_KEY_SECRET
  );
}

/**
 * Reads the shop's flag (service role) and applies `onlinePaymentAllowed`.
 * Fails closed: a missing shop, a soft-deleted shop or a read error (e.g. the
 * column isn't migrated yet) all mean no online payment.
 */
export async function shopAllowsOnlinePayment(admin: SupabaseClient, shopId: string): Promise<boolean> {
  if (!onlinePaymentAllowed(shopId, true)) return false; // every other shop: no read needed
  const { data, error } = await admin
    .from("shops")
    .select("online_payment")
    .eq("id", shopId)
    .is("deleted_at", null)
    .maybeSingle();
  return !error && onlinePaymentAllowed(shopId, data?.online_payment);
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

/**
 * Razorpay helpers. Server-only: every credential comes from environment
 * variables and is never sent to the browser.
 *
 * Each online shop has its OWN merchant account, so its money goes straight to
 * that shop. One set of variables per shop:
 *
 *   RAZORPAY_ENABLED_SHOP_ID        UUID of the shop these keys belong to
 *   RAZORPAY_KEY_ID                 public identifier (returned to checkout)
 *   RAZORPAY_KEY_SECRET             secret — server only
 *   RAZORPAY_WEBHOOK_SECRET         secret — server only, from that account's dashboard
 *
 * That unsuffixed set is the first shop (Sitaram Prints). Every further shop
 * repeats all four with the same suffix: RAZORPAY_ENABLED_SHOP_ID_1,
 * RAZORPAY_KEY_ID_1, ... (K2 Print Store), then _2, and so on.
 * A shop with no set is pay-at-counter only.
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

type Env = Record<string, string | undefined>;

export type RazorpayAccount = { shopId: string; keyId: string; keySecret: string; webhookSecret: string | null };

/** Every fully configured merchant account (shop id + key id + key secret). */
export function razorpayAccounts(env: Env = process.env): RazorpayAccount[] {
  const suffixes = [""];
  for (const name of Object.keys(env)) {
    const n = /^RAZORPAY_ENABLED_SHOP_ID(_[A-Z0-9]+)$/.exec(name)?.[1];
    if (n) suffixes.push(n);
  }
  return suffixes.flatMap((s) => {
    const shopId = env[`RAZORPAY_ENABLED_SHOP_ID${s}`]?.trim().toLowerCase();
    const keyId = env[`RAZORPAY_KEY_ID${s}`];
    const keySecret = env[`RAZORPAY_KEY_SECRET${s}`];
    if (!isUuid(shopId) || !keyId || !keySecret) return [];
    return [{ shopId, keyId, keySecret, webhookSecret: env[`RAZORPAY_WEBHOOK_SECRET${s}`] || null }];
  });
}

/**
 * The shop's own account, or null. Two sets naming the same shop are a
 * misconfiguration, so that shop gets none (fail closed, never a guess).
 */
export function razorpayAccount(shopId: string, env: Env = process.env): RazorpayAccount | null {
  const matches = razorpayAccounts(env).filter((a) => a.shopId === shopId);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The single online-payment gate. True only when the shop has its own
 * configured account and its online_payment flag is true. Anything missing or
 * mismatched means pay-at-counter.
 */
export function onlinePaymentAllowed(shopId: string, onlinePaymentFlag: unknown, env: Env = process.env): boolean {
  return onlinePaymentFlag === true && razorpayAccount(shopId, env) !== null;
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

/** The only events that can change an order; anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = new Set(["payment.captured", "payment.failed", "order.paid", "refund.processed", "refund.failed"]);

/** Pulls only the fields we act on out of Razorpay's envelope. */
export function parsePaymentEvent(body: unknown): ParsedPaymentEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as {
    event?: unknown;
    payload?: Record<string, { entity?: Record<string, unknown> } | undefined>;
  };
  if (typeof b.event !== "string" || !HANDLED_EVENTS.has(b.event)) {
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
  // A refund event's amount is THIS refund's, never the payment's (a partial
  // refund must not look like a full one); refund_id lets the database count
  // each Razorpay refund once.
  if (b.event.startsWith("refund.")) {
    const paymentId = str(ref?.payment_id) ?? str(pay?.id);
    const amountPaise = int(ref?.amount);
    const currency = str(ref?.currency);
    const refundId = str(ref?.id);
    return {
      eventType: b.event,
      paymentOrderId,
      paymentId,
      amountPaise,
      currency,
      payload: { event: b.event, order_id: paymentOrderId, payment_id: paymentId, refund_id: refundId, amount: amountPaise, currency },
    };
  }
  const paymentId = str(pay?.id);
  const amountPaise = int(pay?.amount) ?? int(ord?.amount_paid);
  const currency = str(pay?.currency) ?? str(ord?.currency);
  return {
    eventType: b.event,
    paymentOrderId,
    paymentId,
    amountPaise,
    currency,
    payload: { event: b.event, order_id: paymentOrderId, payment_id: paymentId, amount: amountPaise, currency },
  };
}

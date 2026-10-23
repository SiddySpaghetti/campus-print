/**
 * Exercises the real webhook Route Handler in-process (no network, no database):
 * signature checking, rejection paths and the shape of error bodies.
 * Run: npm run test:security
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

const SECRET = "unit-test-webhook-secret";
const body = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 200, currency: "INR" } } },
});
const sign = (b: string, s = SECRET) => createHmac("sha256", s).update(b).digest("hex");

const post = async (init: { body?: string; headers?: Record<string, string> }) => {
  const { POST } = await import("../app/api/payments/razorpay/webhook/route");
  const res = await POST(
    new Request("http://localhost/api/payments/razorpay/webhook", {
      method: "POST",
      body: init.body ?? body,
      headers: init.headers ?? {},
    }),
  );
  return { status: res.status, text: await res.text() };
};

const noLeak = (text: string) => {
  for (const word of ["SUPABASE", "service_role", SECRET, "stack", "at Object", "node_modules", "SELECT", "postgres"]) {
    assert.equal(text.includes(word), false, `response leaks "${word}": ${text}`);
  }
};

describe("razorpay webhook route", () => {
  const KEYS = [
    "RAZORPAY_ENABLED_SHOP_ID",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.RAZORPAY_ENABLED_SHOP_ID = "6f1c2a8e-1b2c-4d3e-8f90-123456789abc";
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.RAZORPAY_KEY_SECRET = "s";
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY; // never touch a real database in unit tests
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("rejects a missing signature (400)", async () => {
    const r = await post({ headers: { "x-razorpay-event-id": "evt_1" } });
    assert.equal(r.status, 400);
    noLeak(r.text);
  });

  it("rejects an invalid signature (400) — INVALID SIGNATURE test", async () => {
    const r = await post({ headers: { "x-razorpay-signature": sign(body, "wrong-secret"), "x-razorpay-event-id": "evt_1" } });
    assert.equal(r.status, 400);
    noLeak(r.text);
  });

  it("rejects a signature over a different body (tampered payload)", async () => {
    const r = await post({
      body: body.replace("200", "1"),
      headers: { "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_1" },
    });
    assert.equal(r.status, 400);
  });

  it("rejects a garbage signature without crashing", async () => {
    const r = await post({ headers: { "x-razorpay-signature": "not-hex-at-all", "x-razorpay-event-id": "evt_1" } });
    assert.equal(r.status, 400);
  });

  it("a validly signed event without an event id is rejected (cannot dedupe)", async () => {
    const r = await post({ headers: { "x-razorpay-signature": sign(body) } });
    assert.equal(r.status, 400);
  });

  it("a validly signed event reaches the database layer; with no service key it answers a generic 503 and leaks nothing", async () => {
    const r = await post({ headers: { "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_1" } });
    assert.equal(r.status, 503);
    noLeak(r.text);
    assert.deepEqual(JSON.parse(r.text), { error: { code: "unavailable", message: "This feature isn't available right now." } });
  });

  it("with no webhook secret configured it refuses everything (503)", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const r = await post({ headers: { "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_1" } });
    assert.equal(r.status, 503);
    noLeak(r.text);
  });

  it("rejects oversized bodies", async () => {
    const big = "x".repeat(100_001);
    const r = await post({ body: big, headers: { "x-razorpay-signature": sign(big), "x-razorpay-event-id": "evt_1" } });
    assert.equal(r.status, 400);
  });
});

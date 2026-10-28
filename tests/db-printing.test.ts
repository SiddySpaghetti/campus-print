/**
 * The REAL database rules for the printing flow: every file in
 * supabase/migrations is applied, in order, to an in-process Postgres (PGlite),
 * and the triggers/RLS/functions are exercised as each API role. Only Supabase's
 * own pieces are stubbed (auth.users, auth.uid(), storage tables, the API roles
 * and service_role's default table grants). Run: npm run test:security
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import type { PGlite, Transaction } from "@electric-sql/pglite";

import { freshSupabaseDb, ROOT } from "./supabase-pglite";

const STUDENT = "00000000-0000-4000-8000-0000000000a1";
const KEEPER = "00000000-0000-4000-8000-0000000000b1";
const OTHER_KEEPER = "00000000-0000-4000-8000-0000000000b2";
const ADMIN = "00000000-0000-4000-8000-0000000000c1";
const SHOP = "00000000-0000-4000-8000-0000000000d1";
const OTHER_SHOP = "00000000-0000-4000-8000-0000000000d2";

let db: PGlite;
let seq = 0;

type Role = "authenticated" | "service_role";
/** One transaction as an API role, the way PostgREST runs a request. */
function as<T>(role: Role, sub: string | null, fn: (tx: Transaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (sub) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    return fn(tx);
  });
}
const pgCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;

/** Inserts an order as the database owner (fixtures only) and returns its id. */
async function newOrder(o: { status?: string; method?: "ONLINE" | "PAY_AT_COUNTER"; paid?: boolean; shop?: string }) {
  const n = ++seq;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const paid = o.paid ?? o.method !== "PAY_AT_COUNTER";
  await db.query(
    `insert into public.orders (id, order_number, student_id, shop_id, colour_mode, paper_size, sides, copies,
       total_pages, sheets, rate_per_sheet_paise, total_paise, status, payment_method, payment_status, paid_at,
       payment_order_id, payment_id)
     values ($1, $2, $3, $4, 'bw', 'a4', 'single', 1, 2, 2, 150, 300, $5, $6, $7, $8, $9, $10)`,
    [id, `T-${n}`, STUDENT, o.shop ?? SHOP, o.status ?? "PENDING", o.method ?? "ONLINE",
      paid ? "PAID" : "PENDING", paid ? new Date().toISOString() : null, `order_t${n}`, paid ? `pay_t${n}` : null],
  );
  return id;
}
const row = async (id: string) =>
  (await db.query<Record<string, unknown>>("select * from public.orders where id = $1", [id])).rows[0];
const notices = async (id: string) =>
  (await db.query<{ type: string }>("select type from public.notifications where order_id = $1 order by created_at, type", [id]))
    .rows.map((r) => r.type);

/** A verified gateway event, as the webhook/verify routes hand it to process_payment_event. */
async function paymentEvent(id: string, type: string, amount: number, refundId?: string, eventId?: string, currency = "INR") {
  const r = await row(id);
  return as("service_role", null, async (tx) =>
    (await tx.query<{ r: string }>(
      "select public.process_payment_event('razorpay', $1, $2, $3, $4, $5, $6, $7::jsonb) as r",
      [eventId ?? `evt_${type}_${refundId ?? "x"}_${id}`, type, r.payment_order_id, r.payment_id, amount, currency,
        JSON.stringify(refundId ? { refund_id: refundId } : {})],
    )).rows[0].r);
}

const startPrinting = (id: string, shop = SHOP) =>
  as("service_role", null, async (tx) =>
    (await tx.query<{ ok: boolean }>("select public.start_printing($1, $2) as ok", [id, shop])).rows[0].ok);
const shopSets = (id: string, status: string, reason: string | null = null, who = KEEPER) =>
  as("authenticated", who, async (tx) =>
    (await tx.query("update public.orders set status = $2, status_reason = $3 where id = $1", [id, status, reason])).affectedRows);

before(async () => {
  db = await freshSupabaseDb();
  await db.exec(`
    insert into public.shops (id, name, slug, order_prefix, is_verified, is_open, online_payment) values
      ('${SHOP}', 'Shop', 'shop', 'S', true, true, true),
      ('${OTHER_SHOP}', 'Other', 'other', 'O', true, true, false);
    insert into auth.users (id) values ('${STUDENT}'), ('${KEEPER}'), ('${OTHER_KEEPER}'), ('${ADMIN}');
    update public.profiles set role = 'shopkeeper', shop_id = '${SHOP}' where id = '${KEEPER}';
    update public.profiles set role = 'shopkeeper', shop_id = '${OTHER_SHOP}' where id = '${OTHER_KEEPER}';
    update public.profiles set role = 'admin' where id = '${ADMIN}';
  `);
});

describe("db: paid online orders reach the shop and print on download", () => {
  it("a paid online order is in the shop's queue with no Accept; an unpaid one is not", async () => {
    const paid = await newOrder({});
    const unpaid = await newOrder({ paid: false });
    const seen = await as("authenticated", KEEPER, async (tx) =>
      (await tx.query<{ id: string }>("select id from public.orders where id in ($1, $2)", [paid, unpaid])).rows.map((r) => r.id));
    assert.deepEqual(seen, [paid]);
  });

  it("start_printing: PENDING (paid online) -> PRINTING, printing_at set, one notice; a repeat is a no-op", async () => {
    const id = await newOrder({});
    assert.equal(await startPrinting(id), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.accepted_at], ["PRINTING", null]);
    assert.ok(r.printing_at);
    assert.equal(await startPrinting(id), false);
    assert.deepEqual((await row(id)).printing_at, r.printing_at);
    assert.deepEqual(await notices(id), ["order_printing"]);
  });

  it("start_printing refuses unpaid online orders, unaccepted counter orders, other shops and closed orders", async () => {
    const unpaid = await newOrder({ paid: false });
    await assert.rejects(startPrinting(unpaid), pgCode("23514"));
    const counter = await newOrder({ method: "PAY_AT_COUNTER" });
    assert.equal(await startPrinting(counter), false);
    const elsewhere = await newOrder({});
    assert.equal(await startPrinting(elsewhere, OTHER_SHOP), false);
    const rejected = await newOrder({ status: "REJECTED" });
    assert.equal(await startPrinting(rejected), false);
    for (const id of [unpaid, counter, elsewhere]) assert.equal((await row(id)).status, "PENDING");
    assert.equal((await row(rejected)).status, "REJECTED");
  });

  it("pay-at-counter keeps Accept: PENDING -> ACCEPTED (shopkeeper) -> PRINTING (download)", async () => {
    const id = await newOrder({ method: "PAY_AT_COUNTER" });
    assert.equal(await shopSets(id, "ACCEPTED"), 1);
    assert.equal(await startPrinting(id), true);
    assert.equal((await row(id)).status, "PRINTING");
  });

  it("start_printing can't be called by an API session", async () => {
    const id = await newOrder({});
    for (const sub of [KEEPER, ADMIN]) {
      await assert.rejects(
        as("authenticated", sub, (tx) => tx.query("select public.start_printing($1, $2)", [id, SHOP])),
        pgCode("42501"),
      );
    }
    assert.equal((await row(id)).status, "PENDING");
  });
});

describe("db: nobody can set PRINTING directly", () => {
  it("shopkeeper, admin and raw service-role PATCHes are refused (42501); students update nothing", async () => {
    const pending = await newOrder({});
    const accepted = await newOrder({ method: "PAY_AT_COUNTER", status: "ACCEPTED" });
    for (const id of [pending, accepted]) {
      await assert.rejects(shopSets(id, "PRINTING"), pgCode("42501"));
      await assert.rejects(shopSets(id, "PRINTING", null, ADMIN), pgCode("42501"));
      await assert.rejects(
        as("service_role", null, (tx) => tx.query("update public.orders set status = 'PRINTING' where id = $1", [id])),
        pgCode("42501"),
      );
      assert.equal(await shopSets(id, "PRINTING", null, STUDENT), 0);
    }
    assert.deepEqual([(await row(pending)).status, (await row(accepted)).status], ["PENDING", "ACCEPTED"]);
    // Only the counter order's creation notices (20261029120100); nothing from the refused PATCHes.
    assert.deepEqual([...(await notices(pending)), ...(await notices(accepted))], ["new_order", "order_placed"]);
  });

  it("no API role can INSERT an order that is already PRINTING (or past PENDING)", async () => {
    const insert = (status: string) => (tx: Transaction) =>
      tx.query(
        `insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets,
           rate_per_sheet_paise, total_paise, status, payment_method)
         values ($1, $2, 'bw', 'a4', 'single', 1, 2, 2, 150, 300, $3, 'PAY_AT_COUNTER')`,
        [STUDENT, SHOP, status],
      );
    for (const status of ["PRINTING", "READY"]) {
      await assert.rejects(as("authenticated", ADMIN, insert(status)), pgCode("42501")); // orders_admin_all allows insert
      await assert.rejects(as("authenticated", KEEPER, insert(status)), pgCode("42501")); // no insert policy
      await assert.rejects(as("service_role", null, insert(status)), pgCode("42501"));
    }
    const printing = await db.query("select 1 from public.orders where status = 'PRINTING' and printing_at is null");
    assert.equal(printing.rows.length, 0);
  });

  it("real order creation (create_order_verified, as the order API calls it) still works under the insert guard", async () => {
    const path = `${STUDENT}/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf`;
    await db.query("insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise) values ($1, 'print', 'bw', 'a4', 150)", [SHOP]);
    await db.query(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       values ('print-files', $1, $2, '{"size": "1000", "mimetype": "application/pdf"}')`,
      [path, STUDENT],
    );
    const files = JSON.stringify([{ storage_path: path, original_name: "a.pdf", mime_type: "application/pdf", size_bytes: 1000, page_count: 2 }]);
    const created = await as("service_role", null, async (tx) =>
      (await tx.query<{ status: string; payment_method: string }>(
        "select status, payment_method from public.create_order_verified($1, $2, 'bw', 'a4', 'single', 1, $3::jsonb, null, 'ONLINE')",
        [STUDENT, SHOP, files],
      )).rows[0]);
    assert.deepEqual(created, { status: "PENDING", payment_method: "ONLINE" });
  });

  it("no API session, admin included, can set payment state or price: only the payment functions can", async () => {
    const unpaid = await newOrder({ paid: false });
    const rejected = await newOrder({});
    await shopSets(rejected, "REJECTED", "No paper");
    const attempts: [string, string][] = [
      [unpaid, "payment_status = 'PAID'"],
      [unpaid, "paid_at = now(), order_number = 'X-1'"],
      [unpaid, "total_paise = 2, rate_per_sheet_paise = 1"],
      [unpaid, "payment_order_id = 'order_forged'"],
      [rejected, "payment_status = 'REFUNDED'"],
      [rejected, "payment_id = 'pay_forged'"],
    ];
    for (const [id, patch] of attempts) {
      for (const [role, sub] of [["authenticated", ADMIN], ["service_role", null]] as const) {
        await assert.rejects(
          as(role, sub, (tx) => tx.query(`update public.orders set ${patch} where id = $1`, [id])),
          pgCode("42501"),
          `${role} ${patch}`,
        );
      }
    }
    assert.deepEqual([(await row(unpaid)).payment_status, (await row(rejected)).payment_status], ["PENDING", "REFUND_PENDING"]);
    // Admins can still run the order lifecycle (status + reason).
    assert.equal(await shopSets(await newOrder({}), "REJECTED", "Duplicate order", ADMIN), 1);
  });

  it("another shop's keeper can't touch the order at all", async () => {
    const id = await newOrder({});
    assert.equal(await shopSets(id, "REJECTED", "nope", OTHER_KEEPER), 0);
    assert.equal((await row(id)).status, "PENDING");
  });
});

describe("db: reject (no automatic refund), ready for pickup, collected", () => {
  it("rejecting a paid order needs a reason, keeps the payment recorded, and sends the student to the shop", async () => {
    const id = await newOrder({});
    await assert.rejects(shopSets(id, "REJECTED", " "), pgCode("23514"));
    assert.equal(await shopSets(id, "REJECTED", "Corrupt file"), 1);
    let r = await row(id);
    // Paid, not completed: payment record intact, nothing refunded.
    assert.deepEqual([r.status, r.payment_status, r.status_reason, r.refunded_at], ["REJECTED", "REFUND_PENDING", "Corrupt file", null]);
    assert.ok(r.paid_at && r.payment_id && r.rejected_at);
    const body = (await db.query<{ body: string }>("select body from public.notifications where order_id = $1 and type = 'order_rejected'", [id])).rows[0].body;
    assert.equal(body, "Corrupt file Your payment is recorded and has not been refunded. To request a refund, contact the shop.");
    assert.doesNotMatch(body, /will be refunded|refund (is|has been) (issued|processed)|refunded automatically/i); // no promise
    // The shop can't touch payment status: not refunded, not back to paid, not the amount.
    for (const patch of ["payment_status = 'REFUNDED'", "payment_status = 'PAID'", "total_paise = 1, rate_per_sheet_paise = 1, sheets = 1"]) {
      await assert.rejects(
        as("authenticated", KEEPER, (tx) => tx.query(`update public.orders set ${patch} where id = $1`, [id])),
        pgCode("42501"),
      );
    }
    assert.equal((await row(id)).payment_status, "REFUND_PENDING");
    assert.deepEqual(await notices(id), ["order_rejected"]);
    // Only Razorpay's verified refund event (via the webhook/verify routes) can mark it refunded.
    assert.equal(await paymentEvent(id, "refund.processed", 300, "rfnd_Full0001"), "refunded");
    r = await row(id);
    assert.deepEqual([r.payment_status, r.refunded_paise, r.refund_id], ["REFUNDED", 300, "rfnd_Full0001"]);
    assert.ok(r.refunded_at);
    assert.deepEqual(await notices(id), ["order_rejected", "refund_issued"]);
    const audit = await db.query<{ result: string }>("select result from public.payment_events where order_id = $1 and event_type = 'refund.processed'", [id]);
    assert.deepEqual(audit.rows.map((x) => x.result), ["refunded"]); // audit history kept, with the outcome
  });

  it("a refund on a live (PAID, not cancelled) order is recorded but never marks it refunded", async () => {
    const id = await newOrder({});
    assert.equal(await paymentEvent(id, "refund.processed", 300, "rfnd_Live0001"), "refund_on_paid_order");
    const r = await row(id);
    assert.deepEqual([r.payment_status, r.refunded_paise], ["PAID", 300]);
    assert.equal(await paymentEvent(id, "refund.processed", 300), "refund_unverified"); // no Razorpay refund id
  });

  it("partial refunds: never REFUNDED until verified refunds cover the total; same refund id counted once", async () => {
    const id = await newOrder({}); // total 300
    assert.equal(await shopSets(id, "REJECTED", "Printer broke"), 1);
    assert.equal(await paymentEvent(id, "refund.processed", 100, "rfnd_Part0001"), "partially_refunded");
    let r = await row(id);
    assert.deepEqual([r.payment_status, r.refunded_paise, r.refunded_at], ["REFUND_PENDING", 100, null]);
    const notice = (await db.query<{ body: string }>("select body from public.notifications where order_id = $1 and type = 'refund_partial'", [id])).rows;
    assert.deepEqual(notice.map((n) => n.body), [
      "Razorpay confirmed a refund of ₹1.00. ₹2.00 of your payment has not been refunded; to request it, contact the shop.",
    ]);
    // The same refund again (manual reconciliation after the webhook), a too-large one, a failed one, a wrong currency.
    assert.equal(await paymentEvent(id, "refund.processed", 100, "rfnd_Part0001", "manual:rfnd_Part0001"), "duplicate_refund");
    assert.equal(await paymentEvent(id, "refund.processed", 250, "rfnd_Big00001"), "refund_exceeds_total");
    assert.equal(await paymentEvent(id, "refund.failed", 200, "rfnd_Fail0001"), "refund_failed");
    assert.equal(await paymentEvent(id, "refund.processed", 200, "rfnd_Usd00001", undefined, "USD"), "refund_amount_invalid");
    r = await row(id);
    assert.deepEqual([r.payment_status, r.refunded_paise], ["REFUND_PENDING", 100]);
    assert.equal(await paymentEvent(id, "refund.processed", 200, "rfnd_Part0002"), "refunded");
    r = await row(id);
    assert.deepEqual([r.payment_status, r.refunded_paise], ["REFUNDED", 300]);
    assert.deepEqual((await notices(id)).filter((t) => t.startsWith("refund")), ["refund_partial", "refund_issued"]);
  });

  it("a payment captured after the order was cancelled is recorded, surfaced, and both sides are told", async () => {
    const id = await newOrder({ paid: false });
    await db.query("update public.orders set status = 'CANCELLED', status_reason = 'Not paid within 24 hours' where id = $1", [id]);
    assert.equal(await paymentEvent(id, "payment.captured", 300, undefined, `evt_late_${id}`), "paid_after_cancel");
    const r = await row(id);
    assert.deepEqual([r.status, r.payment_status, r.refunded_paise], ["CANCELLED", "REFUND_PENDING", 0]);
    assert.ok(r.paid_at && r.order_number);
    const sent = (await db.query<{ user_id: string; type: string; body: string }>(
      "select user_id, type, body from public.notifications where order_id = $1 and type = 'payment_after_cancel' order by user_id", [id])).rows;
    assert.deepEqual(sent.map((n) => n.user_id).sort(), [KEEPER, STUDENT].sort());
    assert.ok(sent.find((n) => n.user_id === STUDENT)!.body.includes("₹3.00 is recorded and has not been refunded"));
    // Visible to the shop (paid_at set) — that is what the dashboard's "Paid, not completed" list reads.
    const shopSees = await as("authenticated", KEEPER, async (tx) =>
      (await tx.query("select 1 from public.orders where id = $1 and payment_status = 'REFUND_PENDING'", [id])).rows.length);
    assert.equal(shopSees, 1);
    // Out-of-order and duplicate events after that change nothing.
    assert.equal(await paymentEvent(id, "payment.failed", 300, undefined, `evt_late_fail_${id}`), "ignored_state");
    assert.equal(await paymentEvent(id, "payment.captured", 300, undefined, `evt_late_${id}`), "duplicate");
    assert.equal(await paymentEvent(id, "order.paid", 300, undefined, `evt_late_op_${id}`), "ignored_state");
    assert.equal((await row(id)).payment_status, "REFUND_PENDING");
    assert.equal((await db.query("select 1 from public.notifications where order_id = $1 and type = 'payment_after_cancel'", [id])).rows.length, 2);
  });

  it("docs/refund-reconciliation.md: its queries run on the real schema and its manual confirmation is audited", async () => {
    const doc = readFileSync(join(ROOT, "docs/refund-reconciliation.md"), "utf8");
    const query = (name: string) => doc.match(new RegExp(`<!-- ${name}:start -->\\s*\`\`\`sql\\n([\\s\\S]*?)\`\`\``))![1];
    const id = await newOrder({});
    await shopSets(id, "REJECTED", "Printer broke");
    // Unpaid order cancelled (e.g. the 24h job), then Razorpay captures the still-open checkout.
    const late = await newOrder({ paid: false });
    await db.query("update public.orders set status = 'CANCELLED', status_reason = 'Not paid within 24 hours' where id = $1", [late]);
    await db.query("update public.orders set payment_status = 'PAID' where id = $1", [late]);
    assert.equal((await row(late)).payment_status, "REFUND_PENDING"); // the lifecycle's late-payment rule
    const [rejected, latePaidOrder] = [await row(id), await row(late)];
    const daily = await db.query<{ order_number: string }>(query("daily-query"));
    assert.ok(daily.rows.some((x) => x.order_number === rejected.order_number));
    const latePaid = await db.query<{ order_number: string }>(query("late-payment-query"));
    assert.ok(latePaid.rows.some((x) => x.order_number === latePaidOrder.order_number));
    assert.ok(!latePaid.rows.some((x) => x.order_number === rejected.order_number)); // paid before it was rejected
    await db.query(query("order-events-query").replace("'K-001'", "$1"), [rejected.order_number]);
    const refundEvents = await db.query<{ result: string }>(query("refund-events-query"));
    assert.ok(refundEvents.rows.some((x) => x.result === "partially_refunded")); // from the partial-refund test above

    // The manual confirmation snippet, with real ids, records an audit row and marks REFUNDED.
    const r = await row(id);
    const manual = doc.match(/```sql\n(select public\.process_payment_event\([\s\S]*?\);)\n```/)![1]
      .replace("'manual:rfnd_XXXXXXXXXXXX'", "'manual:rfnd_T1'")
      .replace('"refund_id": "rfnd_XXXXXXXXXXXX"', '"refund_id": "rfnd_Manual001"')
      .replace("'order_XXXXXXXXXXXX'", `'${r.payment_order_id}'`)
      .replace("'pay_XXXXXXXXXXXX'", `'${r.payment_id}'`)
      .replace("20000", "300");
    assert.equal((await db.query<{ process_payment_event: string }>(manual)).rows[0].process_payment_event, "refunded");
    assert.equal((await row(id)).payment_status, "REFUNDED");
    const audit = await db.query("select 1 from public.payment_events where event_id = 'manual:rfnd_T1' and payload->>'source' = 'manual_reconciliation'");
    assert.equal(audit.rows.length, 1);
    assert.equal((await db.query<{ process_payment_event: string }>(manual)).rows[0].process_payment_event, "duplicate");
  });

  it("cancelling while printing records it as paid, not completed (no refund issued)", async () => {
    const id = await newOrder({});
    await startPrinting(id);
    assert.equal(await shopSets(id, "CANCELLED", "Printer broke"), 1);
    const r = await row(id);
    assert.deepEqual([r.payment_status, r.refunded_at], ["REFUND_PENDING", null]);
  });

  it("READY only from PRINTING (one 'ready' notice), then COMPLETED; closing the shop blocks none of it", async () => {
    const id = await newOrder({});
    await assert.rejects(shopSets(id, "READY"), pgCode("23514"));
    await startPrinting(id);
    await db.query("update public.shops set is_open = false where id = $1", [SHOP]);
    assert.equal(await shopSets(id, "READY"), 1);
    assert.equal(await shopSets(id, "COMPLETED"), 1);
    await db.query("update public.shops set is_open = true where id = $1", [SHOP]);
    const r = await row(id);
    assert.equal(r.status, "COMPLETED");
    assert.ok(r.ready_at && r.completed_at);
    assert.deepEqual(await notices(id), ["order_printing", "order_ready", "order_completed"]);
  });
});

describe("db: placing an order notifies the student and the shop (counter now, online on payment)", () => {
  /** What POST /api/orders does: create_order_verified as the service role, for an uploaded file. */
  async function place(method: "ONLINE" | "PAY_AT_COUNTER", file = `${STUDENT}/${randomUUID()}/${randomUUID()}.pdf`) {
    await db.query(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       select 'print-files', $1, $2, '{"size": "1000", "mimetype": "application/pdf"}'
        where not exists (select 1 from storage.objects where name = $1)`,
      [file, STUDENT],
    );
    const files = JSON.stringify([{ storage_path: file, original_name: "a.pdf", mime_type: "application/pdf", size_bytes: 1000, page_count: 2 }]);
    const id = await as("service_role", null, async (tx) =>
      (await tx.query<{ id: string }>(
        "select (public.create_order_verified($1, $2, 'bw', 'a4', 'single', 1, $3::jsonb, null, $4)).id as id",
        [STUDENT, SHOP, files, method],
      )).rows[0].id);
    return { id, file };
  }
  const recipients = async (id: string) =>
    (await db.query<{ who: string; type: string }>(
      "select user_id::text as who, type from public.notifications where order_id = $1 order by type", [id])).rows;

  before(() =>
    db.exec(`insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise)
             values ('${SHOP}', 'print', 'bw', 'a4', 150) on conflict do nothing`));

  it("a counter order: the student is told it was placed and the shop's keeper is alerted, once each", async () => {
    const { id } = await place("PAY_AT_COUNTER");
    assert.deepEqual(await recipients(id), [{ who: KEEPER, type: "new_order" }, { who: STUDENT, type: "order_placed" }]);
    const student = (await db.query<{ title: string; body: string }>(
      "select title, body from public.notifications where order_id = $1 and type = 'order_placed'", [id])).rows[0];
    assert.match(student.title, /^Order S-\d{3} placed$/);
    assert.match(student.body, /Pay at the counter/);
  });

  it("an unpaid online order gets no notice; payment confirmation arrives once, only when payment is verified", async () => {
    const { id } = await place("ONLINE");
    assert.deepEqual(await recipients(id), []);
    await as("service_role", null, (tx) =>
      tx.query("select public.attach_payment_order($1, $2, $3)", [id, STUDENT, `order_${randomUUID().replaceAll("-", "").slice(0, 20)}`]));
    const total = Number((await row(id)).total_paise);
    assert.equal(await paymentEvent(id, "payment.captured", total), "paid");
    assert.equal(await paymentEvent(id, "payment.captured", total), "duplicate");
    assert.deepEqual(await recipients(id), [{ who: KEEPER, type: "new_order" }, { who: STUDENT, type: "order_placed" }]);
    const body = (await db.query<{ body: string }>(
      "select body from public.notifications where order_id = $1 and type = 'order_placed'", [id])).rows[0].body;
    assert.match(body, /^Payment received/);
  });

  it("retrying the same request returns the same order and adds no second notice", async () => {
    const first = await place("PAY_AT_COUNTER");
    const retry = await place("PAY_AT_COUNTER", first.file);
    assert.equal(retry.id, first.id);
    assert.equal((await recipients(first.id)).length, 2);
  });

  it("the keeper sees only their own alert and can mark it read; the student and other shops can't see it", async () => {
    const { id } = await place("PAY_AT_COUNTER");
    const seen = (who: string) =>
      as("authenticated", who, async (tx) =>
        (await tx.query<{ type: string }>("select type from public.notifications where order_id = $1", [id])).rows.map((r) => r.type));
    assert.deepEqual(await seen(KEEPER), ["new_order"]);
    assert.deepEqual(await seen(STUDENT), ["order_placed"]);
    assert.deepEqual(await seen(OTHER_KEEPER), []);
    const marked = await as("authenticated", KEEPER, async (tx) =>
      (await tx.query("update public.notifications set read_at = now() where order_id = $1 and read_at is null", [id])).affectedRows);
    assert.equal(marked, 1);
  });
});

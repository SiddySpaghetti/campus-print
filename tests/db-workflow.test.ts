/**
 * The accept-then-pay workflow against the REAL SQL (PGlite): every file in
 * supabase/migrations plus the switch held back in docs/workflow-upgrade, as each
 * API role. One connection, so row-lock races are not exercised here.
 * Run: npm run test:security
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import type { PGlite, Transaction } from "@electric-sql/pglite";

import { freshSupabaseDb, ROOT } from "./supabase-pglite";

const release = (file: string) => readFileSync(join(ROOT, "docs/workflow-upgrade", file), "utf8");

const STUDENT = "00000000-0000-4000-8000-0000000000a1";
const KEEPER = "00000000-0000-4000-8000-0000000000b1";
const OTHER_KEEPER = "00000000-0000-4000-8000-0000000000b2";
const SHOP = "00000000-0000-4000-8000-0000000000d1";
const OTHER_SHOP = "00000000-0000-4000-8000-0000000000d2";
const TIER_SHOP = "00000000-0000-4000-8000-0000000000d3";

/** Mirrors SHOP_TRANSITIONS: the route's compare-and-set. */
const FROM: Record<string, string[]> = {
  ACCEPTED: ["PENDING"], READY: ["PRINTING"], COMPLETED: ["READY"], REJECTED: ["PENDING"], CANCELLED: ["ACCEPTED", "PRINTING"],
};

let db: PGlite;
let gw = 0;

function as<T>(role: "authenticated" | "service_role", sub: string | null, fn: (tx: Transaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (sub) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    return fn(tx);
  });
}
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const row = async (id: string) =>
  (await db.query<Record<string, unknown>>("select * from public.orders where id = $1", [id])).rows[0];
const notices = async (id: string, user: string) =>
  (await db.query<{ type: string }>("select type from public.notifications where order_id = $1 and user_id = $2 order by created_at, type", [id, user])).rows.map((r) => r.type);

async function upload(pages: number) {
  const p = `${STUDENT}/${randomUUID()}/${randomUUID()}.pdf`;
  await db.query("insert into storage.objects (bucket_id, name, metadata) values ('print-files', $1, $2)", [p, JSON.stringify({ size: "100", mimetype: "application/pdf" })]);
  return { storage_path: p, original_name: `${pages}p.pdf`, mime_type: "application/pdf", size_bytes: 100, page_count: pages };
}
async function create(o: { pages?: number[]; sides?: string; copies?: number; method?: string; shop?: string } = {}) {
  await db.query("delete from private.rate_limits");
  const files: Awaited<ReturnType<typeof upload>>[] = [];
  for (const p of o.pages ?? [1]) files.push(await upload(p));
  const r = await as("service_role", null, async (tx) =>
    (await tx.query<{ id: string }>("select id from public.create_order_verified($1,$2,'bw','a4',$3,$4,$5::jsonb,null,$6)",
      [STUDENT, o.shop ?? SHOP, o.sides ?? "single", o.copies ?? 1, JSON.stringify(files), o.method ?? "ONLINE"])).rows[0]);
  return r.id;
}
const shopSets = (id: string, status: string, reason: string | null = null, who = KEEPER) =>
  as("authenticated", who, async (tx) =>
    (await tx.query("update public.orders set status = $2, status_reason = $3 where id = $1 and status = any(string_to_array($4, chr(44))::public.order_status[])", [id, status, reason, FROM[status].join(",")])).affectedRows);
const attach = (id: string) =>
  as("service_role", null, (tx) => tx.query("select public.attach_payment_order($1,$2,$3)", [id, STUDENT, `order_DRY${String(++gw).padStart(8, "0")}`]));
async function event(id: string, type: string, amount: number, evt?: string, refund?: string) {
  const r = await row(id);
  return as("service_role", null, async (tx) =>
    (await tx.query<{ r: string }>("select public.process_payment_event('razorpay',$1,$2,$3,$4,$5,'INR',$6::jsonb) as r",
      [evt ?? `evt_${type}_${id}`, type, r.payment_order_id, "pay_ABCDEF123", amount, JSON.stringify(refund ? { refund_id: refund } : {})])).rows[0].r);
}
const svc = <T,>(sql: string, ...a: unknown[]) =>
  as("service_role", null, async (tx) => (await tx.query<{ r: T }>(sql, a)).rows[0].r);
const requestPrint = (id: string, shop = SHOP) => svc<string | null>("select public.request_print($1,$2) as r", id, shop);
const confirmPrinting = (id: string, shop = SHOP) => svc<boolean>("select public.confirm_printing($1,$2) as r", id, shop);
const cancelByStudent = (id: string) => as("authenticated", STUDENT, (tx) => tx.query("select public.cancel_order($1)", [id]));
const shopSeesFile = async (id: string, who = KEEPER) => {
  const { rows } = await db.query<{ storage_path: string }>("select storage_path from public.order_files where order_id = $1 limit 1", [id]);
  return as("authenticated", who, async (tx) =>
    (await tx.query<{ r: boolean }>("select private.shop_can_read_file($1) as r", [rows[0].storage_path])).rows[0].r);
};
const shopSeesOrder = (id: string, who = KEEPER) =>
  as("authenticated", who, async (tx) => (await tx.query("select id from public.orders where id = $1", [id])).rows.length === 1);
const total = async (id: string) => (await row(id)).total_paise as number;

before(async () => {
  db = await freshSupabaseDb();
  await db.exec(release("20261103120100_accept_first_default_on.sql"));
  await db.exec(`
    insert into public.shops (id, name, slug, order_prefix, is_verified, is_open, online_payment) values
      ('${SHOP}', 'Shop', 'shop', 'S', true, true, true), ('${OTHER_SHOP}', 'Other', 'other', 'O', true, true, false),
      ('${TIER_SHOP}', 'Tier', 'tier', 'T', true, true, true);
    insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise) values
      ('${SHOP}', 'print', 'bw', 'a4', 200), ('${TIER_SHOP}', 'print', 'bw', 'a4', 500);
    insert into public.shop_page_price_tiers (shop_id, colour_mode, paper_size, min_pages, price_paise) values
      ('${TIER_SHOP}', 'bw', 'a4', 1, 500), ('${TIER_SHOP}', 'bw', 'a4', 4, 300), ('${TIER_SHOP}', 'bw', 'a4', 9, 200);
    insert into auth.users (id) values ('${STUDENT}'), ('${KEEPER}'), ('${OTHER_KEEPER}');
    update public.profiles set role = 'shopkeeper', shop_id = '${SHOP}' where id = '${KEEPER}';
    update public.profiles set role = 'shopkeeper', shop_id = '${OTHER_SHOP}' where id = '${OTHER_KEEPER}';
  `);
});

describe("accept-then-pay", () => {
  it("a new order reaches the shop as metadata only, can't be paid yet, and is accepted exactly once", async () => {
    const id = await create();
    const o = await row(id);
    assert.deepEqual([o.status, o.payment_status, o.accept_first, o.order_number], ["PENDING", "PENDING", true, null]);
    assert.deepEqual(await notices(id, STUDENT), ["order_placed"]);
    assert.deepEqual(await notices(id, KEEPER), ["new_order"]);
    assert.equal(await shopSeesOrder(id), true);
    assert.equal(await shopSeesOrder(id, OTHER_KEEPER), false, "shop isolation");
    assert.equal(await shopSeesFile(id), false, "the bytes stay unreadable");
    await assert.rejects(attach(id), code("P0001"), "no payment before acceptance");
    assert.equal(await shopSets(id, "ACCEPTED", null, OTHER_KEEPER), 0, "another shop can't accept it");
    assert.equal(await shopSets(id, "ACCEPTED"), 1);
    assert.equal(await shopSets(id, "ACCEPTED"), 0, "duplicate acceptance changes nothing");
    assert.deepEqual(await notices(id, STUDENT), ["order_placed", "order_accepted"]);
  });

  it("an accepted unpaid order cannot be printed by any path", async () => {
    const id = await create();
    await shopSets(id, "ACCEPTED");
    assert.equal(await shopSeesFile(id), false);
    await assert.rejects(requestPrint(id), code("P0001"));
    assert.equal(await confirmPrinting(id), false, "no hand-over recorded");
    await db.query("update public.orders set print_requested_at = now() where id = $1", [id]);
    await assert.rejects(confirmPrinting(id), code("23514"), "lifecycle refuses even with a forged hand-over");
    await assert.rejects(db.query("update public.orders set status = 'PRINTING' where id = $1", [id]), code("23514"));
    await assert.rejects(as("authenticated", KEEPER, (tx) => tx.query("update public.orders set status = 'PRINTING' where id = $1", [id])), code("42501"));
    assert.equal((await row(id)).status, "ACCEPTED");
  });

  it("paying unlocks printing; webhook replay and verify+webhook apply once; a failed payment can retry", async () => {
    const id = await create();
    await shopSets(id, "ACCEPTED");
    await attach(id);
    assert.equal(await event(id, "payment.failed", 0), "failed");
    assert.equal((await row(id)).payment_status, "FAILED");
    await assert.rejects(requestPrint(id), code("P0001"));
    const amt = await total(id);
    assert.equal(await event(id, "payment.captured", amt, "evt_cap"), "paid");
    assert.equal(await event(id, "payment.captured", amt, "evt_cap"), "duplicate");
    assert.equal(await event(id, "order.paid", amt, "evt_ord"), "ignored_state");
    const o = await row(id);
    assert.equal(o.payment_status, "PAID");
    assert.ok(o.order_number, "numbered at payment, as today");
    assert.deepEqual(await notices(id, KEEPER), ["new_order", "order_paid"]);
    assert.equal(await shopSeesFile(id), true);
    assert.equal(await shopSeesFile(id, OTHER_KEEPER), false, "shop isolation");

    assert.equal(await confirmPrinting(id), false, "confirm needs a hand-over");
    assert.equal(await requestPrint(id), null);
    assert.ok(await requestPrint(id), "a second hand-over reports the first");
    await assert.rejects(requestPrint(id, OTHER_SHOP), code("P0001"));
    assert.equal((await row(id)).status, "ACCEPTED", "handing over does not start printing");
    assert.equal(await confirmPrinting(id, OTHER_SHOP), false);
    assert.equal(await confirmPrinting(id), true);
    assert.equal(await confirmPrinting(id), false, "a repeat is a no-op");
    assert.equal((await notices(id, STUDENT)).filter((t) => t === "order_printing").length, 1);
    assert.ok(await requestPrint(id), "reprint after a jam is allowed");
    assert.equal(await shopSets(id, "READY"), 1);
    assert.equal(await shopSets(id, "COMPLETED"), 1);
    assert.equal((await row(id)).payment_status, "PAID");
  });

  it("a wrong amount never unlocks anything", async () => {
    const id = await create();
    await shopSets(id, "ACCEPTED");
    await attach(id);
    assert.equal(await event(id, "payment.captured", 1), "amount_mismatch");
    assert.equal((await row(id)).payment_status, "PENDING");
  });

  it("reject needs a reason, tells the student and blocks payment", async () => {
    const id = await create();
    await assert.rejects(shopSets(id, "REJECTED", "  "), code("23514"));
    assert.equal(await shopSets(id, "REJECTED", "Printer down"), 1);
    assert.deepEqual((await db.query<{ body: string }>("select body from public.notifications where order_id = $1 and type = 'order_rejected'", [id])).rows.map((r) => r.body), ["Printer down"]);
    await assert.rejects(attach(id), code("P0001"));
    assert.equal((await row(id)).payment_status, "PENDING");
  });

  it("student cancels until paid, not after; late capture stays reconcilable; partial then full refund", async () => {
    const a = await create();
    await cancelByStudent(a);
    assert.equal((await row(a)).status, "CANCELLED");

    const b = await create();
    await shopSets(b, "ACCEPTED");
    await attach(b);
    await cancelByStudent(b);
    assert.equal((await row(b)).status, "CANCELLED");
    assert.equal(await event(b, "payment.captured", await total(b)), "paid_after_cancel");
    assert.equal((await row(b)).payment_status, "REFUND_PENDING");
    assert.ok((await notices(b, KEEPER)).includes("payment_after_cancel"));
    await assert.rejects(requestPrint(b), code("P0001"));

    const c = await create({ pages: [5] });
    await shopSets(c, "ACCEPTED");
    await attach(c);
    await event(c, "payment.captured", await total(c));
    await requestPrint(c);
    await cancelByStudent(c);
    assert.deepEqual([(await row(c)).status, (await row(c)).payment_status], ["CANCELLED", "REFUND_PENDING"], "paid, not yet printing: the existing refund workflow");
    assert.equal((await row(c)).refunded_paise, 0, "nothing is refunded automatically");
    assert.ok((await notices(c, KEEPER)).includes("order_cancelled_by_student"), "the shop is told to stop");
    assert.equal(await confirmPrinting(c), false, "too late to mark it printing");
    await assert.rejects(requestPrint(c), code("P0001"));
    const t = await total(c);
    assert.equal(await event(c, "refund.processed", 100, "evt_r1", "rfnd_AAAAAA1"), "partially_refunded");
    assert.equal(await event(c, "refund.processed", 100, "evt_r1b", "rfnd_AAAAAA1"), "duplicate_refund");
    assert.equal(await event(c, "refund.processed", t - 100, "evt_r2", "rfnd_AAAAAA2"), "refunded");
    assert.equal((await row(c)).payment_status, "REFUNDED");
  });

  it("once printing starts the student can't cancel; the shop still can, into the same workflow", async () => {
    const id = await create();
    await shopSets(id, "ACCEPTED");
    await attach(id);
    await event(id, "payment.captured", await total(id));
    await requestPrint(id);
    assert.equal(await confirmPrinting(id), true);
    await assert.rejects(cancelByStudent(id), code("P0001"));
    assert.equal((await row(id)).status, "PRINTING");
    assert.equal(await shopSets(id, "CANCELLED", "Printer failed"), 1);
    assert.equal((await row(id)).payment_status, "REFUND_PENDING");
  });

  it("cancelling a counter order keeps today's rule: while pending only, with no new shop notice", async () => {
    const pending = await create({ method: "PAY_AT_COUNTER" });
    await cancelByStudent(pending);
    assert.equal((await row(pending)).status, "CANCELLED");
    assert.deepEqual(await notices(pending, KEEPER), ["new_order"]);
    const accepted = await create({ method: "PAY_AT_COUNTER" });
    await shopSets(accepted, "ACCEPTED");
    await assert.rejects(cancelByStudent(accepted), code("P0001"));
  });

  it("auto-cancel: unaccepted and accepted-unpaid expire with the right reason; counter ACCEPTED and paid don't", async () => {
    const unaccepted = await create();
    const unpaid = await create();
    await shopSets(unpaid, "ACCEPTED");
    const counter = await create({ method: "PAY_AT_COUNTER" });
    await shopSets(counter, "ACCEPTED");
    const paid = await create();
    await shopSets(paid, "ACCEPTED");
    await attach(paid);
    await event(paid, "payment.captured", await total(paid));
    await db.query("update public.orders set created_at = now() - interval '2 days', accepted_at = now() - interval '2 days' where id = any($1)", [[unaccepted, unpaid, counter, paid]]);
    await db.query("select private.cancel_stale_unpaid_orders()");
    assert.deepEqual([(await row(unaccepted)).status, (await row(unaccepted)).status_reason], ["CANCELLED", "Not accepted by the shop within 24 hours"]);
    assert.deepEqual([(await row(unpaid)).status, (await row(unpaid)).status_reason], ["CANCELLED", "Not paid within 24 hours of being accepted"]);
    assert.equal((await row(counter)).status, "ACCEPTED");
    assert.equal((await row(paid)).status, "ACCEPTED");
    assert.equal((await row(paid)).payment_status, "PAID", "a confirmed payment is never expired");

    // Idempotent: a second run changes nothing and tells nobody again.
    const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.notifications")).rows[0].n;
    const before = await count();
    assert.equal((await db.query<{ n: number }>("select private.cancel_stale_unpaid_orders() as n")).rows[0].n, 0);
    assert.equal(await count(), before);

    // A capture that lands after expiry is recorded and reconcilable, never lost.
    await db.exec("set session_replication_role = replica");
    await db.query("update public.orders set payment_order_id = 'order_LATE00001' where id = $1", [unpaid]);
    await db.exec("set session_replication_role = origin");
    assert.equal(await event(unpaid, "payment.captured", await total(unpaid), "evt_late"), "paid_after_cancel");
    assert.equal((await row(unpaid)).payment_status, "REFUND_PENDING");
  });

  it("pay-at-counter is unchanged", async () => {
    const id = await create({ method: "PAY_AT_COUNTER" });
    assert.ok((await row(id)).order_number);
    assert.deepEqual(await notices(id, KEEPER), ["new_order"]);
    assert.equal(await shopSeesFile(id), true);
    await assert.rejects(requestPrint(id), code("P0001"), "accept first");
    await shopSets(id, "ACCEPTED");
    assert.equal(await requestPrint(id), null);
    assert.equal(await confirmPrinting(id), true);
    await shopSets(id, "READY");
    await shopSets(id, "COMPLETED");
    assert.deepEqual([(await row(id)).status, (await row(id)).payment_status], ["COMPLETED", "PENDING"]);
    await assert.rejects(attach(id), code("P0001"));
  });

  it("legacy pay-first orders keep working and stay hidden until paid", async () => {
    await db.exec("alter table public.orders alter column accept_first set default false");
    const id = await create();
    await db.exec("alter table public.orders alter column accept_first set default true");
    assert.deepEqual(await notices(id, KEEPER), []);
    assert.equal(await shopSeesOrder(id), false);
    await attach(id);
    await event(id, "payment.captured", await total(id));
    assert.deepEqual(await notices(id, KEEPER), ["new_order"]);
    assert.equal(await shopSeesOrder(id), true);
    assert.equal(await requestPrint(id), null);
    assert.equal(await confirmPrinting(id), true);
    const o = await row(id);
    assert.equal(o.status, "PRINTING");
    assert.equal(o.accepted_at, null);
  });

  it("the schema itself refuses unpaid online work, even with triggers bypassed", async () => {
    const id = await create();
    await db.exec("set session_replication_role = replica");
    await assert.rejects(db.query("update public.orders set status = 'PRINTING' where id = $1", [id]), code("23514"));
    await db.exec("set session_replication_role = origin");
  });
});

describe("late payments", () => {
  const closedWithGateway = async (status: "CANCELLED" | "REJECTED") => {
    const id = await create();
    if (status === "CANCELLED") {
      await shopSets(id, "ACCEPTED");
      await attach(id);
      await cancelByStudent(id);
    } else {
      await shopSets(id, "REJECTED", "Printer down");
      await db.exec("set session_replication_role = replica");
      await db.query("update public.orders set payment_order_id = $2 where id = $1", [id, `order_LATE${String(++gw).padStart(8, "0")}`]);
      await db.exec("set session_replication_role = origin");
    }
    return id;
  };

  it("a payment after cancellation doesn't reopen the order: flagged, REFUND_PENDING, later than the cancellation", async () => {
    const id = await closedWithGateway("CANCELLED");
    assert.equal(await event(id, "payment.captured", await total(id), `late_${id}`), "paid_after_cancel");
    const o = await row(id);
    assert.deepEqual([o.status, o.payment_status, o.paid_after_cancel], ["CANCELLED", "REFUND_PENDING", true]);
    assert.ok((o.paid_at as Date) >= (o.cancelled_at as Date));
    assert.ok(o.order_number, "still numbered, so it can be found");
    assert.equal(await shopSeesFile(id), true);
    await assert.rejects(requestPrint(id), code("P0001"), "still can't be printed");
    assert.equal(await confirmPrinting(id), false);

    const notes = (await db.query<{ title: string; body: string }>("select title, body from public.notifications where order_id = $1 and type = 'payment_after_cancel' order by title", [id])).rows;
    assert.equal(notes.length, 2, "student and shop, once each");
    assert.ok(notes.some((n) => /paid after it was cancelled/.test(n.title) && /Nothing was printed/.test(n.body)));
    assert.ok(notes.some((n) => /Payment received for cancelled order/.test(n.title)));
  });

  it("a payment after rejection says rejected, for both sides", async () => {
    const id = await closedWithGateway("REJECTED");
    assert.equal(await event(id, "payment.captured", await total(id), `late_${id}`), "paid_after_cancel");
    const o = await row(id);
    assert.deepEqual([o.status, o.payment_status, o.paid_after_cancel], ["REJECTED", "REFUND_PENDING", true]);
    const titles = (await db.query<{ title: string }>("select title from public.notifications where order_id = $1 and type = 'payment_after_cancel'", [id])).rows.map((n) => n.title).join(" | ");
    assert.match(titles, /paid after it was rejected/);
    assert.match(titles, /Payment received for rejected order/);
    assert.doesNotMatch(titles, /cancelled/);
  });

  it("paid first, then cancelled: not a late payment", async () => {
    const id = await create();
    await shopSets(id, "ACCEPTED");
    await attach(id);
    await event(id, "payment.captured", await total(id));
    await cancelByStudent(id);
    const o = await row(id);
    assert.deepEqual([o.status, o.payment_status, o.paid_after_cancel], ["CANCELLED", "REFUND_PENDING", false]);
    assert.ok((o.paid_at as Date) <= (o.cancelled_at as Date));
    assert.equal(await notices(id, KEEPER).then((n) => n.includes("payment_after_cancel")), false);
  });

  it("delayed and duplicate webhooks change nothing further, even after the refund", async () => {
    const id = await closedWithGateway("CANCELLED");
    const amt = await total(id);
    await event(id, "payment.captured", amt, `late_${id}`);
    const first = await row(id);
    assert.equal(await event(id, "payment.captured", amt, `late_${id}`), "duplicate");
    assert.equal(await event(id, "order.paid", amt, `late2_${id}`), "ignored_state");
    assert.equal(await event(id, "payment.failed", 0, `late3_${id}`), "ignored_state");
    const again = await row(id);
    assert.deepEqual([again.paid_at, again.status, again.payment_status], [first.paid_at, "CANCELLED", "REFUND_PENDING"]);
    assert.equal(await event(id, "refund.processed", amt, `r_${id}`, `rfnd_L${String(++gw).padStart(7, "0")}`), "refunded");
    assert.equal(await event(id, "payment.captured", amt, `late4_${id}`), "ignored_state");
    const done = await row(id);
    assert.deepEqual([done.status, done.payment_status, done.paid_after_cancel], ["CANCELLED", "REFUNDED", true]);
    assert.equal((await db.query("select 1 from public.notifications where order_id = $1 and type = 'payment_after_cancel'", [id])).rows.length, 2);
  });

  it("no API role can set the flag", async () => {
    const id = await create();
    await assert.rejects(as("authenticated", KEEPER, (tx) => tx.query("update public.orders set paid_after_cancel = true where id = $1", [id])), code("42501"));
    assert.equal((await row(id)).paid_after_cancel, false);
  });
});

describe("Migration 1 records late payments already in the database", () => {
  it("flags only real late payments, without notices or other changes", async () => {
    const S = "00000000-0000-4000-8000-0000000000e1";
    const U = "00000000-0000-4000-8000-0000000000e2";
    const [late, event_, early] = ["e3", "e4", "e5"].map((x) => `00000000-0000-4000-8000-0000000000${x}`);
    const row_ = (id: string, n: string, paid: string, cancelled: string) => `('${id}', '${U}', '${S}', 'bw', 'a4', 'single', 1, 1, 1, 100, 100, 'CANCELLED', 'REFUND_PENDING', 'ONLINE', '${n}', '${paid}', '${cancelled}')`;
    const old = await freshSupabaseDb({
      "20261103120000": `
        insert into public.shops (id, name, slug, order_prefix, is_verified) values ('${S}', 'Old', 'old', 'Q', true);
        insert into auth.users (id) values ('${U}');
        insert into public.orders (id, student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise, status, payment_status, payment_method, order_number, paid_at, cancelled_at) values
          ${row_(late, "Q-1", "2026-10-20T10:05:00Z", "2026-10-20T10:00:00Z")},
          ${row_(event_, "Q-2", "2026-10-20T09:59:00Z", "2026-10-20T10:00:00Z")},
          ${row_(early, "Q-3", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z")};
        insert into public.payment_events (provider, event_id, event_type, order_id, payload, result) values ('razorpay', 'e1', 'payment.captured', '${event_}', '{}', 'paid_after_cancel');
        insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count, created_at) values
          ('${late}', 'a/first.pdf', 'first.pdf', 'application/pdf', 1, 1, '2026-10-20T09:00:00Z'),
          ('${late}', 'a/second.pdf', 'second.pdf', 'application/pdf', 1, 1, '2026-10-20T09:00:01Z');
      `,
    });
    assert.deepEqual((await old.query<{ original_name: string; sort_order: number }>("select original_name, sort_order from public.order_files order by sort_order")).rows.map((f) => [f.original_name, f.sort_order]), [["first.pdf", 0], ["second.pdf", 1]], "an existing multi-file order keeps its order and doesn't break the unique index");
    const flags = (await old.query<{ id: string; paid_after_cancel: boolean }>("select id, paid_after_cancel from public.orders order by order_number")).rows.map((r) => r.paid_after_cancel);
    assert.deepEqual(flags, [true, true, false], "later timestamp, recorded result, genuinely paid first");
    assert.equal((await old.query("select 1 from public.notifications")).rows.length, 0);
  });
});

describe("multiple documents", () => {
  it("stores the student's order; total and quote agree; double-sided rounds per document", async () => {
    const id = await create({ pages: [3, 3, 1], sides: "double", copies: 2 });
    const files = await db.query<{ sort_order: number; page_count: number }>("select sort_order, page_count from public.order_files where order_id = $1 order by sort_order", [id]);
    assert.deepEqual(files.rows.map((f) => [f.sort_order, f.page_count]), [[0, 3], [1, 3], [2, 1]]);
    const o = await row(id);
    assert.deepEqual([o.total_pages, o.sheets, o.pricing_unit, o.total_paise], [7, 10, "sheet", 2000]);
    const q = await svc<{ totalPaise: number; sheets: number; totalPages: number }>("select public.quote_order($1,'bw','a4','double',2,$2) as r", SHOP, [3, 3, 1]);
    assert.deepEqual([q.totalPaise, q.sheets, q.totalPages], [2000, 10, 7]);
  });

  it("per-page tiers bill pages x copies across all documents, sides ignored", async () => {
    const id = await create({ pages: [2, 3], sides: "double", copies: 2, shop: TIER_SHOP });
    const o = await row(id);
    assert.deepEqual([o.total_pages, o.pricing_unit, o.rate_per_sheet_paise, o.total_paise], [5, "page", 200, 2000]);
    const q = await svc<{ totalPaise: number; unit: string }>("select public.quote_order($1,'bw','a4','double',2,$2) as r", TIER_SHOP, [2, 3]);
    assert.deepEqual([q.totalPaise, q.unit], [2000, "page"]);
    const small = await svc<{ totalPaise: number }>("select public.quote_order($1,'bw','a4','single',1,$2) as r", TIER_SHOP, [1, 1]);
    assert.equal(small.totalPaise, 1000);
  });

  it("11 documents, an unknown option and a closed shop are refused", async () => {
    await assert.rejects(svc("select public.quote_order($1,'bw','a4','single',1,$2) as r", SHOP, Array(11).fill(1)), code("22023"));
    await assert.rejects(svc("select public.quote_order($1,'colour','a4','single',1,$2) as r", SHOP, [1]), code("P0002"));
    await db.query("update public.shops set is_open = false where id = $1", [SHOP]);
    await assert.rejects(svc("select public.quote_order($1,'bw','a4','single',1,$2) as r", SHOP, [1]), code("P0002"));
    await db.query("update public.shops set is_open = true where id = $1", [SHOP]);
  });
});

describe("rollback SQL", () => {
  it("refuses while accept_first orders exist, then restores the old schema", async () => {
    const a = release("rollback_20261103120000.sql");
    const b = release("rollback_20261103120100.sql");
    const c = release("rollback_20261103120200.sql");
    await db.exec(release("20261103120200_printing_only_via_confirm.sql"));
    await assert.rejects(db.query("select 'public.start_printing(uuid,uuid)'::regprocedure"), /start_printing/, "migration 3 removes the old function");
    const printed = await create();
    await shopSets(printed, "ACCEPTED");
    await attach(printed);
    await event(printed, "payment.captured", await total(printed));
    await requestPrint(printed);
    assert.equal(await confirmPrinting(printed), true, "printing still works after migration 3");
    await db.exec(c);
    await db.exec(b);
    await assert.rejects(db.exec(a), /accept_first orders/);
    await db.exec("rollback").catch(() => {});
    await db.exec("set session_replication_role = replica; delete from public.notifications; delete from public.order_files; delete from public.payment_events; delete from public.orders; set session_replication_role = origin;");
    await db.exec(a);
    const cols = await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name in ('accept_first','print_requested_at')");
    assert.equal(cols.rows.length, 0);
    await db.query("select 'public.start_printing(uuid,uuid)'::regprocedure");
    await db.query("select 'public.create_order_verified(uuid,uuid,text,text,text,int,jsonb,text,text)'::regprocedure");
    assert.equal((await db.query("select 1 from pg_proc where proname in ('request_print','confirm_printing','quote_order','price_order')")).rows.length, 0);
    const id = await create({ pages: [1] });
    assert.equal((await row(id)).status, "PENDING");
    assert.deepEqual(await notices(id, KEEPER), [], "old behaviour: an unpaid online order is silent");
  });
});

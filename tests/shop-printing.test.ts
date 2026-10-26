/**
 * Shop printing flow through the REAL route handlers (download -> PRINTING,
 * Ready for pickup, Mark collected), with requireRole and validation unmocked.
 * Only the two Supabase client factories are replaced by an in-memory fake that
 * mirrors the RLS policies (orders_select_shop / orders_update_shop /
 * order_files_select_shop) and the orders_lifecycle + orders_notify triggers.
 * Run: npm run test:security
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shopActions } from "../components/flow/order-actions";
import { PaidNotCompleted } from "../components/flow/shop-dashboard";
import { paymentLabel } from "../lib/orders";

type Row = Record<string, unknown>;
type Db = { profiles: Row[]; orders: Row[]; order_files: Row[]; notifications: Row[] };

const SHOP_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHOP_B = "bbbbbbbb-0000-4000-8000-000000000002";
const KEEPER_A = "11111111-0000-4000-8000-000000000001";
const KEEPER_B = "22222222-0000-4000-8000-000000000002";
const STUDENT = "33333333-0000-4000-8000-000000000003";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: Db;
let currentUser: string | null;
let signingWorks: boolean;

const MOVES: Record<string, string[]> = {
  PENDING: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PRINTING", "CANCELLED"],
  PRINTING: ["READY", "CANCELLED"],
  READY: ["COMPLETED"],
};
const NOTICE: Record<string, string> = {
  ACCEPTED: "order_accepted", PRINTING: "order_printing", READY: "order_ready",
  COMPLETED: "order_completed", REJECTED: "order_rejected", CANCELLED: "order_cancelled",
};

const me = () => db.profiles.find((p) => p.id === currentUser);
const shopSees = (o: Row) =>
  me()?.role === "shopkeeper" && o.shop_id === me()?.shop_id && (o.paid_at != null || o.payment_method === "PAY_AT_COUNTER");
const canRead = (table: keyof Db, r: Row): boolean => {
  if (table === "profiles") return r.id === currentUser;
  if (table === "orders") return shopSees(r) || r.student_id === currentUser;
  if (table === "order_files") return canRead("orders", db.orders.find((o) => o.id === r.order_id)!);
  return false;
};

/**
 * orders_guard + orders_lifecycle + orders_notify for one change; throws like
 * the triggers. `viaStartPrinting` = inside start_printing, the only caller the
 * guard lets set PRINTING. tests/db-printing.test.ts runs the real SQL.
 */
function applyOrderUpdate(o: Row, patch: Row, viaStartPrinting = false) {
  if (patch.status !== o.status) {
    if (!viaStartPrinting && patch.status === "PRINTING") throw { code: "42501" };
    const online = o.payment_method === "ONLINE";
    const moves = [...(MOVES[o.status as string] ?? []), ...(online && o.status === "PENDING" ? ["PRINTING"] : [])];
    if (!moves.includes(patch.status as string)) throw { code: "23514" };
    if (["ACCEPTED", "PRINTING", "READY", "COMPLETED"].includes(patch.status as string)
      && o.payment_status !== "PAID" && o.payment_method !== "PAY_AT_COUNTER") throw { code: "23514" };
    o[`${(patch.status as string).toLowerCase()}_at`] = new Date().toISOString();
    if (["CANCELLED", "REJECTED"].includes(patch.status as string) && o.payment_status === "PAID") {
      o.payment_status = "REFUND_PENDING";
    }
    db.notifications.push({ user_id: o.student_id, order_id: o.id, type: NOTICE[patch.status as string] });
  }
  Object.assign(o, patch);
}

/** The shopkeeper/student session client (RLS applies). */
function from(table: keyof Db) {
  const filters: [string, unknown][] = [];
  let patch: Row | null = null;
  const builder = {
    select: () => builder,
    update: (p: Row) => ((patch = p), builder),
    eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
    in: (c: string, v: unknown[]) => (filters.push([c, v]), builder),
    maybeSingle: async () => {
      const rows = db[table].filter((r) =>
        filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)),
      );
      if (patch) {
        const target = rows.find((r) => table === "orders" && shopSees(r)); // orders_update_shop
        if (!target) return { data: null, error: null };
        try {
          applyOrderUpdate(target, patch);
        } catch (error) {
          return { data: null, error };
        }
        return { data: { id: target.id, status: target.status }, error: null };
      }
      const row = rows.find((r) => canRead(table, r));
      if (!row) return { data: null, error: null };
      if (table !== "order_files") return { data: row, error: null };
      const order = db.orders.find((o) => o.id === row.order_id)!;
      return { data: { ...row, order: canRead("orders", order) ? order : null }, error: null };
    },
  };
  return builder;
}

const fakeClient = {
  auth: { getUser: async () => (currentUser ? { data: { user: { id: currentUser } }, error: null } : { data: { user: null }, error: { message: "no session" } }) },
  from,
  storage: {
    from: () => ({
      createSignedUrl: async (path: string) =>
        signingWorks ? { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null } : { data: null, error: { message: "boom" } },
    }),
  },
};

mock.module("../utils/supabase/server.ts", { namedExports: { createClient: async () => fakeClient } });
/** check_rate_limit always allows; start_printing mirrors the SQL function (a CAS, trusted by the guard). */
const adminClient = {
  rpc: async (name: string, args: { p_order_id?: string; p_shop_id?: string }) => {
    if (name !== "start_printing") return { data: true, error: null };
    const o = db.orders.find((r) => r.id === args.p_order_id && r.shop_id === args.p_shop_id
      && (r.status === "ACCEPTED" || (r.status === "PENDING" && r.payment_method === "ONLINE")));
    if (!o) return { data: false, error: null };
    try {
      applyOrderUpdate(o, { status: "PRINTING" }, true);
    } catch (error) {
      return { data: null, error };
    }
    return { data: true, error: null };
  },
};
mock.module("../utils/supabase/admin.ts", { namedExports: { createAdminClient: () => adminClient } });

/** A shopkeeper's own session PATCHing PostgREST directly, bypassing our routes. */
const directUpdate = (orderId: string, patch: Row) => from("orders").update(patch).eq("id", orderId).maybeSingle();

const ctx = (value: string) => ({ params: Promise.resolve({ id: value }) }) as never;

async function download(fileId: string) {
  const { POST } = await import("../app/api/shop/files/[id]/route");
  const res = await POST(new Request(`http://localhost/api/shop/files/${fileId}`, { method: "POST" }), ctx(fileId));
  return { status: res.status, body: (await res.json()) as { url?: string; error?: { code: string } } };
}

async function setStatus(orderId: string, status: string) {
  const { POST } = await import("../app/api/shop/orders/[id]/status/route");
  const res = await POST(
    new Request(`http://localhost/api/shop/orders/${orderId}/status`, { method: "POST", body: JSON.stringify({ status }) }),
    ctx(orderId),
  );
  return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
}

const order = (n: number, o: Row): Row => ({
  id: id(n), shop_id: SHOP_A, student_id: STUDENT, status: "ACCEPTED", payment_method: "ONLINE",
  payment_status: "PAID", paid_at: "2026-10-25T04:00:00Z", printing_at: null, ready_at: null, ...o,
});
const file = (n: number, orderN: number, o: Row = {}): Row => ({
  id: id(100 + n), order_id: id(orderN), storage_path: `${STUDENT}/u/${n}.pdf`, original_name: `doc${n}.pdf`, file_deleted_at: null, ...o,
});
const get = (n: number) => db.orders.find((o) => o.id === id(n))!;
const notices = (n: number, type?: string) =>
  db.notifications.filter((x) => x.order_id === id(n) && (!type || x.type === type)).length;

beforeEach(() => {
  currentUser = KEEPER_A;
  signingWorks = true;
  db = {
    profiles: [
      { id: KEEPER_A, role: "shopkeeper", shop_id: SHOP_A, deleted_at: null },
      { id: KEEPER_B, role: "shopkeeper", shop_id: SHOP_B, deleted_at: null },
      { id: STUDENT, role: "student", shop_id: null, deleted_at: null },
    ],
    orders: [
      order(1, {}), // paid online, accepted
      order(2, { payment_method: "PAY_AT_COUNTER", payment_status: "PENDING", paid_at: null }),
      order(3, { status: "PENDING", payment_status: "PENDING", paid_at: null }), // unpaid online: hidden by RLS
      order(4, { payment_status: "PENDING" }), // paid_at set but payment not verified
      order(5, { status: "CANCELLED", payment_status: "REFUND_PENDING" }),
      order(6, { status: "PENDING" }), // paid online: arrived in the queue on its own
      order(7, { status: "PRINTING", printing_at: "2026-10-25T05:00:00Z" }),
      order(9, { status: "PENDING", payment_method: "PAY_AT_COUNTER", payment_status: "PENDING", paid_at: null }),
    ],
    order_files: [
      file(1, 1), file(2, 2), file(3, 3), file(4, 4), file(5, 5), file(6, 6), file(7, 7),
      file(8, 1, { file_deleted_at: "2026-10-25T00:00:00Z" }), file(9, 9),
    ],
    notifications: [],
  };
});

describe("downloading a document starts printing", () => {
  it("a paid online order arrives without Accept; its download -> signed URL, PRINTING, one notice", async () => {
    assert.equal(get(6).accepted_at, undefined);
    const r = await download(id(106));
    assert.equal(r.status, 200);
    assert.match(r.body.url!, /^https:\/\/storage\.test\//);
    assert.equal(get(6).status, "PRINTING");
    assert.ok(get(6).printing_at);
    assert.deepEqual(db.notifications.map((x) => x.type), ["order_printing"]);
  });

  it("an order accepted before this change (ACCEPTED) also prints on download", async () => {
    const r = await download(id(101));
    assert.equal(r.status, 200);
    assert.match(r.body.url!, /^https:\/\/storage\.test\//);
    assert.equal(get(1).status, "PRINTING");
    assert.ok(get(1).printing_at);
    assert.equal(notices(1, "order_printing"), 1);
  });

  it("re-downloading is allowed and changes nothing (no second notice, same printing_at)", async () => {
    await download(id(101));
    const first = get(1).printing_at;
    for (let i = 0; i < 3; i++) assert.equal((await download(id(101))).status, 200);
    assert.equal(get(1).status, "PRINTING");
    assert.equal(get(1).printing_at, first);
    assert.equal(notices(1), 1);
  });

  it("an order already printing can be re-downloaded without being reset", async () => {
    assert.equal((await download(id(107))).status, 200);
    assert.equal(get(7).status, "PRINTING");
    assert.equal(get(7).printing_at, "2026-10-25T05:00:00Z");
    assert.equal(notices(7), 0);
  });

  it("pay-at-counter orders still work unpaid", async () => {
    assert.equal((await download(id(102))).status, 200);
    assert.equal(get(2).status, "PRINTING");
  });

  it("a PENDING counter order must be accepted first: its download is only a look", async () => {
    assert.equal((await download(id(109))).status, 200);
    assert.equal(get(9).status, "PENDING");
    assert.equal(notices(9), 0);
    assert.equal((await setStatus(id(9), "ACCEPTED")).status, 200);
    assert.equal((await download(id(109))).status, 200);
    assert.equal(get(9).status, "PRINTING");
  });
});

describe("downloads that must not start printing", () => {
  const unchanged = (n: number, status = "ACCEPTED") => {
    assert.equal(get(n).status, status);
    assert.equal(notices(n), 0);
  };

  it("another shop's keeper: 404", async () => {
    currentUser = KEEPER_B;
    assert.equal((await download(id(101))).status, 404);
    unchanged(1);
  });

  it("the student who owns the order: 403", async () => {
    currentUser = STUDENT;
    assert.equal((await download(id(101))).status, 403);
    unchanged(1);
  });

  it("signed out: 401", async () => {
    currentUser = null;
    assert.equal((await download(id(101))).status, 401);
    unchanged(1);
  });

  it("an unpaid online order is invisible to the shop: 404", async () => {
    assert.equal((await download(id(103))).status, 404);
    unchanged(3, "PENDING");
  });

  it("an online order without verified payment is refused even if visible: 409", async () => {
    const r = await download(id(104));
    assert.deepEqual([r.status, r.body.error?.code], [409, "unpaid"]);
    unchanged(4);
  });

  it("if the signed URL can't be prepared: 502 and the order stays ACCEPTED", async () => {
    signingWorks = false;
    const r = await download(id(101));
    assert.deepEqual([r.status, r.body.error?.code, r.body.url], [502, "download_failed", undefined]);
    unchanged(1);
  });

  it("a cancelled order: 409, stays cancelled", async () => {
    assert.equal((await download(id(105))).status, 409);
    unchanged(5, "CANCELLED");
  });

  it("a purged file or a malformed id: 404 / 400", async () => {
    assert.equal((await download(id(108))).status, 404);
    assert.equal((await download("not-a-uuid")).status, 400);
    unchanged(1);
  });
});

describe("ready for pickup and collected", () => {
  it("PRINTING -> READY notifies the student once; a second click fails without a duplicate", async () => {
    assert.equal((await setStatus(id(7), "READY")).status, 200);
    assert.equal(get(7).status, "READY");
    assert.equal(notices(7, "order_ready"), 1);
    assert.equal((await setStatus(id(7), "READY")).status, 409);
    assert.equal(notices(7, "order_ready"), 1);
  });

  it("only from PRINTING: ACCEPTED, PENDING and CANCELLED orders are refused", async () => {
    for (const n of [1, 6, 5]) {
      const before = get(n).status;
      assert.equal((await setStatus(id(n), "READY")).status, 409);
      assert.equal(get(n).status, before);
      assert.equal(notices(n), 0);
    }
  });

  it("direct attempts to set PRINTING are denied (status route 400, own-session PATCH 42501)", async () => {
    assert.equal((await setStatus(id(1), "PRINTING")).status, 400);
    assert.equal((await setStatus(id(6), "PRINTING")).status, 400);
    const r = await directUpdate(id(6), { status: "PRINTING" });
    assert.equal((r.error as { code?: string } | null)?.code, "42501");
    assert.equal(get(1).status, "ACCEPTED");
    assert.equal(get(6).status, "PENDING");
    assert.equal(db.notifications.length, 0);
  });

  it("rejecting a paid online order records the reason and keeps it paid-not-completed (nothing refunded)", async () => {
    const { POST } = await import("../app/api/shop/orders/[id]/status/route");
    const res = await POST(
      new Request(`http://localhost/api/shop/orders/${id(6)}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "REJECTED", reason: "File is corrupt" }),
      }),
      ctx(id(6)),
    );
    assert.equal(res.status, 200);
    assert.deepEqual([get(6).status, get(6).payment_status, get(6).status_reason], ["REJECTED", "REFUND_PENDING", "File is corrupt"]);
    assert.equal(notices(6, "order_rejected"), 1);
    assert.equal(notices(6, "refund_issued"), 0);
    assert.equal((await download(id(106))).status, 409); // closed: no printing after rejection
  });

  it("a shopkeeper can't set payment status through the status route", async () => {
    const { POST } = await import("../app/api/shop/orders/[id]/status/route");
    for (const body of [{ status: "REFUNDED" }, { status: "ACCEPTED", payment_status: "PAID" }, { payment_status: "REFUNDED" }]) {
      const res = await POST(
        new Request(`http://localhost/api/shop/orders/${id(5)}/status`, { method: "POST", body: JSON.stringify(body) }),
        ctx(id(5)),
      );
      assert.equal(res.status, 400);
    }
    assert.equal(get(5).payment_status, "REFUND_PENDING");
  });

  it("another shop or a student can't mark it ready", async () => {
    for (const user of [KEEPER_B, STUDENT]) {
      currentUser = user;
      assert.ok([403, 409].includes((await setStatus(id(7), "READY")).status));
    }
    assert.equal(get(7).status, "PRINTING");
  });

  it("UI promises no refund: neutral labels and buttons, Refunded only as Razorpay's confirmed state", () => {
    assert.equal(paymentLabel({ payment_status: "REFUND_PENDING", payment_method: "ONLINE" }), "Paid · not completed");
    assert.equal(paymentLabel({ payment_status: "REFUNDED", payment_method: "ONLINE" }), "Refunded");
    for (const status of ["PENDING", "ACCEPTED", "PRINTING", "READY"]) {
      for (const online of [true, false]) {
        for (const a of shopActions(status, online)) assert.doesNotMatch(a.label, /refund/i, `${status} ${a.label}`);
      }
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []);
    for (const f of ["app", "components", "lib"].flatMap((d) => walk(join(root, d)))) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /& refund|Refund pending|refund policy|money back|full refund/i, f);
    }
  });

  it("the shop sees every paid-not-completed order, with the reason, until it is settled", () => {
    const o = { id: id(5), order_number: "S-005", status: "CANCELLED" as const, status_reason: "Printer broke",
      payment_status: "REFUND_PENDING", payment_method: "ONLINE", total_paise: 300, created_at: "2026-10-25T04:00:00Z" };
    const html = renderToStaticMarkup(createElement(PaidNotCompleted, { orders: [o] }));
    for (const text of ["Paid, not completed (1)", "#S-005", "Paid · not completed", "Reason: Printer broke", "settle each one"]) {
      assert.ok(html.includes(text), text);
    }
    assert.equal(renderToStaticMarkup(createElement(PaidNotCompleted, { orders: [] })), "");
    assert.equal(html.includes("Paid after it was cancelled"), false);
    const late = renderToStaticMarkup(createElement(PaidNotCompleted, {
      orders: [{ ...o, cancelled_at: "2026-10-25T04:00:00Z", paid_at: "2026-10-25T04:05:00Z" }],
    }));
    assert.ok(late.includes("Paid after it was cancelled"));
  });

  it("only the download route calls start_printing, and no app code writes PRINTING itself", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []);
    const files = ["app", "components", "lib", "utils"].flatMap((d) => walk(join(root, d)));
    const callers = files.filter((f) => readFileSync(f, "utf8").includes("start_printing"));
    assert.deepEqual(callers.map((f) => f.slice(root.length + 1).replaceAll("\\", "/")), ["app/api/shop/files/[id]/route.ts"]);
    for (const f of files) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /status:\s*"PRINTING"/, f);
    }
  });

  it("full flow: paid order -> download -> ready for pickup -> mark collected", async () => {
    await download(id(106));
    assert.equal((await setStatus(id(6), "READY")).status, 200);
    assert.equal((await setStatus(id(6), "COMPLETED")).status, 200);
    assert.equal(get(6).status, "COMPLETED");
    assert.deepEqual(db.notifications.map((x) => x.type), ["order_printing", "order_ready", "order_completed"]);
  });
});

/** Shop dashboard: today's totals and the recently-closed toggle. Run: npm run test:security */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { pollWhileVisible } from "../components/flow/order-actions";
import { DailyStatsCards, RecentlyClosed, ShopAlerts, type DashboardOrder } from "../components/flow/shop-dashboard";
import { ACTIVE_PAGE, CLOSED_PAGE, closedPageParam, loadActiveOrders, loadClosedOrders } from "../lib/shop-queue";
import { dailyStats, istDayBounds, loadDailyStats, type StatsRow } from "../lib/shop-stats";

describe("new-order alerts", () => {
  it("are shown on the dashboard, with a way to mark them read; nothing renders without any", () => {
    const alert = { id: "n1", type: "new_order", title: "New order S-007", body: "Pay at the counter. Accept it to start printing.",
      created_at: "2026-10-29T04:00:00Z" };
    const html = renderToStaticMarkup(
      createElement(AppRouterContext.Provider, { value: {} as never }, createElement(ShopAlerts, { alerts: [alert] })));
    for (const text of ["New alerts (1)", "New order S-007", "Accept it to start printing", "Mark all as read"]) {
      assert.ok(html.includes(text), text);
    }
    assert.equal(renderToStaticMarkup(createElement(ShopAlerts, { alerts: [] })), "");
  });
});

const SHOP = "shop-a";
const NOW = new Date("2026-10-21T10:00:00Z"); // 15:30 IST, 21 Oct
const row = (o: Partial<StatsRow>): StatsRow => ({
  shop_id: SHOP, status: "COMPLETED", payment_status: "PAID", total_pages: 10, copies: 1,
  total_paise: 5000, ready_at: null, completed_at: null, ...o,
});

describe("Asia/Kolkata day", () => {
  it("starts at 18:30 UTC the previous day", () => {
    assert.deepEqual(istDayBounds(NOW), { start: "2026-10-20T18:30:00.000Z", end: "2026-10-21T18:30:00.000Z" });
  });
  it("rolls over at IST midnight, not UTC midnight", () => {
    assert.equal(istDayBounds(new Date("2026-10-21T18:29:59.999Z")).start, "2026-10-20T18:30:00.000Z");
    assert.equal(istDayBounds(new Date("2026-10-21T18:30:00.000Z")).start, "2026-10-21T18:30:00.000Z");
    assert.equal(istDayBounds(new Date("2026-10-20T20:00:00Z")).start, "2026-10-20T18:30:00.000Z"); // 01:30 IST
  });
});

describe("daily stats", () => {
  it("counts printed pages (pages x copies) by ready_at, around midnight", () => {
    const s = dailyStats([
      row({ status: "READY", total_pages: 7, copies: 3, ready_at: "2026-10-20T18:30:00+00:00" }), // 00:00 IST today
      row({ total_pages: 4, ready_at: "2026-10-21T18:29:59+00:00" }), // 23:59 IST today
      row({ total_pages: 100, ready_at: "2026-10-20T18:29:59+00:00" }), // 23:59 IST yesterday
      row({ total_pages: 100, ready_at: "2026-10-21T18:30:00+00:00" }), // 00:00 IST tomorrow
    ], SHOP, NOW);
    assert.equal(s.pagesPrinted, 21 + 4);
  });

  it("sums completed order value by completed_at", () => {
    const s = dailyStats([
      row({ total_paise: 12500, ready_at: "2026-10-20T10:00:00Z", completed_at: "2026-10-21T04:00:00Z" }),
      row({ total_paise: 300, completed_at: "2026-10-21T18:00:00Z" }),
      row({ status: "READY", total_paise: 999, ready_at: "2026-10-21T05:00:00Z" }), // not collected yet
      row({ total_paise: 999, completed_at: "2026-10-20T18:00:00Z" }), // yesterday IST
    ], SHOP, NOW);
    assert.equal(s.completedPaise, 12800);
  });

  it("excludes cancelled, rejected and refunded orders", () => {
    const today = "2026-10-21T05:00:00Z";
    const s = dailyStats([
      row({ status: "CANCELLED", payment_status: "REFUND_PENDING", ready_at: today, completed_at: today }),
      row({ status: "REJECTED", ready_at: today, completed_at: today }),
      row({ payment_status: "REFUNDED", total_pages: 2, ready_at: today, completed_at: today }),
    ], SHOP, NOW);
    assert.deepEqual(s, { pagesPrinted: 2, completedPaise: 0 }); // the refunded order was still printed
  });

  it("counts an order once even when it moved READY -> COMPLETED today", () => {
    const s = dailyStats([row({ total_pages: 5, copies: 2, total_paise: 700, ready_at: "2026-10-21T04:00:00Z", completed_at: "2026-10-21T05:00:00Z" })], SHOP, NOW);
    assert.deepEqual(s, { pagesPrinted: 10, completedPaise: 700 });
  });

  it("ignores another shop's orders", () => {
    const s = dailyStats([row({ shop_id: "shop-b", ready_at: "2026-10-21T04:00:00Z", completed_at: "2026-10-21T05:00:00Z" })], SHOP, NOW);
    assert.deepEqual(s, { pagesPrinted: 0, completedPaise: 0 });
  });
});

function fakeClient(result: { data: StatsRow[] | null; error: unknown; count: number | null }) {
  const calls: unknown[][] = [];
  const builder = {
    select: (...a: unknown[]) => (calls.push(["select", ...a]), builder),
    eq: (...a: unknown[]) => (calls.push(["eq", ...a]), builder),
    or: (...a: unknown[]) => (calls.push(["or", ...a]), builder),
    returns: () => Promise.resolve(result),
  };
  const client = { from: (t: string) => (calls.push(["from", t]), builder) } as unknown as SupabaseClient;
  return { client, calls };
}

describe("loadDailyStats", () => {
  it("scopes the query to the given shop and today's IST window", async () => {
    const { client, calls } = fakeClient({ data: [row({ ready_at: "2026-10-21T04:00:00Z" })], error: null, count: 1 });
    assert.deepEqual(await loadDailyStats(client, SHOP, NOW), { pagesPrinted: 10, completedPaise: 0 });
    assert.deepEqual(calls.find((c) => c[0] === "eq"), ["eq", "shop_id", SHOP]);
    assert.match(String(calls.find((c) => c[0] === "or")?.[1]), /ready_at\.gte\.2026-10-20T18:30:00\.000Z,ready_at\.lt\.2026-10-21T18:30:00\.000Z/);
  });
  it("returns null (not zeros) when the query fails", async () => {
    const { client } = fakeClient({ data: null, error: { code: "57014", message: "timeout" }, count: null });
    assert.equal(await loadDailyStats(client, SHOP, NOW), null);
  });
  it("returns null when the result was truncated", async () => {
    const { client } = fakeClient({ data: [row({})], error: null, count: 1001 });
    assert.equal(await loadDailyStats(client, SHOP, NOW), null);
  });
});

describe("dashboard UI", () => {
  const order = (o: Partial<DashboardOrder>): DashboardOrder => ({
    id: "11111111-2222", order_number: "A-001", status: "COMPLETED", status_reason: null,
    payment_status: "PAID", payment_method: "ONLINE", total_paise: 1250_00, created_at: "2026-10-21T05:00:00Z", ...o,
  });

  it("recently closed is a collapsed <details> toggle with the count", () => {
    const html = renderToStaticMarkup(createElement(RecentlyClosed, {
      orders: [order({}), order({ id: "x", order_number: "A-002", status: "CANCELLED", status_reason: "Paper out" })],
    }));
    assert.match(html, /^<details class="[^"]*"><summary/); // no `open` attribute
    assert.match(html, /Recently closed \(2\)/);
    for (const text of ["#A-001", "#A-002", "Collected", "Cancelled", "Paid", "₹1,250", "Reason: Paper out"]) {
      assert.ok(html.includes(text), `missing ${text}`);
    }
  });
  it("recently closed has an empty state", () => {
    const html = renderToStaticMarkup(createElement(RecentlyClosed, { orders: [] }));
    assert.match(html, /Recently closed \(0\)/);
    assert.ok(html.includes("No closed orders yet"));
  });
  it("stats cards show pages and rupees", () => {
    const html = renderToStaticMarkup(createElement(DailyStatsCards, { stats: { pagesPrinted: 1234, completedPaise: 1250_00 } }));
    for (const text of ["Pages printed today", "1,234", "Amount collected today", "₹1,250"]) assert.ok(html.includes(text), `missing ${text}`);
  });
  it("a failed stats read shows an error with retry, never ₹0", () => {
    const html = renderToStaticMarkup(createElement(DailyStatsCards, { stats: null }));
    assert.ok(html.includes('role="alert"') && html.includes("Retry"));
    assert.ok(!html.includes("₹"));
  });
});

describe("AutoRefresh polling", () => {
  const fakeDoc = (state: DocumentVisibilityState) => {
    const target = new EventTarget();
    const doc = Object.assign(target, { visibilityState: state });
    const set = (next: DocumentVisibilityState) => {
      doc.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    };
    return { doc, set };
  };

  it("ticks while visible, stops while hidden, ticks once on return, then resumes", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { doc, set } = fakeDoc("visible");
      let ticks = 0;
      const stop = pollWhileVisible(() => ticks++, 15_000, doc);
      mock.timers.tick(30_000);
      assert.equal(ticks, 2);
      set("hidden");
      mock.timers.tick(60_000);
      assert.equal(ticks, 2, "no polling in a hidden tab");
      set("visible");
      assert.equal(ticks, 3, "one refresh on return");
      set("visible"); // a repeated event is not a second return
      assert.equal(ticks, 3);
      mock.timers.tick(14_999);
      assert.equal(ticks, 3, "the interval restarts from the return, no double tick");
      mock.timers.tick(1);
      assert.equal(ticks, 4);
      stop();
      mock.timers.tick(60_000);
      set("hidden");
      set("visible");
      assert.equal(ticks, 4, "cleanup removes both the interval and the listener");
    } finally {
      mock.timers.reset();
    }
  });

  it("a tab opened in the background waits until it is shown", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { doc, set } = fakeDoc("hidden");
      let ticks = 0;
      const stop = pollWhileVisible(() => ticks++, 15_000, doc);
      mock.timers.tick(60_000);
      assert.equal(ticks, 0);
      set("visible");
      assert.equal(ticks, 1);
      stop();
    } finally {
      mock.timers.reset();
    }
  });
});

describe("shop queue queries", () => {
  /** Records every builder call; each awaited query returns the next page. */
  function pagedClient(pages: { data: unknown[] | null; error: unknown }[]) {
    const calls: unknown[][] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "range"]) {
      builder[m] = (...a: unknown[]) => (calls.push([m, ...a]), builder);
    }
    builder.returns = () => Promise.resolve(pages.shift() ?? { data: [], error: null });
    const client = { from: (t: string) => (calls.push(["from", t]), builder) } as unknown as SupabaseClient;
    return { client, calls };
  }
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `o${from + i}`, order_files: [] }));

  it("fetches every active order, past the old 200 cap, oldest first, for this shop only", async () => {
    const { client, calls } = pagedClient([
      { data: rows(ACTIVE_PAGE), error: null },
      { data: rows(ACTIVE_PAGE, ACTIVE_PAGE), error: null },
      { data: rows(7, 2 * ACTIVE_PAGE), error: null },
    ]);
    const orders = await loadActiveOrders(client, SHOP);
    assert.equal(orders.length, 2 * ACTIVE_PAGE + 7);
    assert.equal(new Set(orders.map((o) => o.id)).size, orders.length);
    assert.deepEqual(calls.filter((c) => c[0] === "range"), [["range", 0, 199], ["range", 200, 399], ["range", 400, 599]]);
    assert.ok(calls.every((c) => c[0] !== "eq" || (c[1] === "shop_id" && c[2] === SHOP)));
    assert.deepEqual(calls.find((c) => c[0] === "in"), ["in", "status", ["PENDING", "ACCEPTED", "PRINTING", "READY"]]);
    assert.deepEqual(calls.find((c) => c[0] === "order"), ["order", "created_at", { ascending: true }]);
    assert.match(String(calls.find((c) => c[0] === "select")?.[1]), /order_files\(/);
  });
  it("a failed page throws instead of showing a partial queue", async () => {
    const { client } = pagedClient([{ data: rows(ACTIVE_PAGE), error: null }, { data: null, error: { message: "timeout" } }]);
    await assert.rejects(loadActiveOrders(client, SHOP));
  });
  it("closed orders come a page at a time, without files, and say whether an older page exists", async () => {
    const { client, calls } = pagedClient([{ data: rows(CLOSED_PAGE + 1), error: null }]);
    const page = await loadClosedOrders(client, SHOP, 2);
    assert.equal(page.orders.length, CLOSED_PAGE);
    assert.equal(page.hasOlder, true);
    assert.deepEqual(calls.find((c) => c[0] === "range"), ["range", 60, 90]);
    assert.deepEqual(calls.find((c) => c[0] === "in"), ["in", "status", ["COMPLETED", "CANCELLED", "REJECTED"]]);
    assert.doesNotMatch(String(calls.find((c) => c[0] === "select")?.[1]), /order_files|student_note/);

    const last = await loadClosedOrders(pagedClient([{ data: rows(3), error: null }]).client, SHOP, 0);
    assert.equal(last.hasOlder, false);
    const failed = await loadClosedOrders(pagedClient([{ data: null, error: { message: "x" } }]).client, SHOP, 0);
    assert.ok(failed.error && failed.orders.length === 0);
  });
  it("?closed= only accepts a sane page number", () => {
    for (const [v, n] of [[undefined, 0], ["2", 2], ["-1", 0], ["1.5", 0], ["abc", 0], ["99999", 0], [["3", "4"], 3]] as const) {
      assert.equal(closedPageParam(v as string | string[] | undefined), n, String(v));
    }
  });
  it("closed list pages link newer/older and open expanded past the first page", () => {
    const order = { id: "c1", order_number: "A-009", status: "COMPLETED" as const, status_reason: null,
      payment_status: "PAID", payment_method: "ONLINE", total_paise: 100, created_at: "2026-10-21T05:00:00Z" };
    const render = (props: { page?: number; hasOlder?: boolean }) => renderToStaticMarkup(
      createElement(AppRouterContext.Provider, { value: {} as never }, createElement(RecentlyClosed, { orders: [order], ...props })));
    const first = render({ hasOlder: true });
    assert.match(first, /Recently closed \(1\+\)/);
    assert.ok(first.includes('href="/shop?closed=1#closed"') && !first.includes(">Newer<"));
    assert.doesNotMatch(first, /<details[^>]* open/);
    const second = render({ page: 1 });
    assert.match(second, /<details[^>]* open/);
    assert.ok(second.includes('href="/shop#closed"') && !second.includes(">Older<"));
  });
});

/** Shop dashboard: today's totals and the recently-closed toggle. Run: npm run test:security */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { DailyStatsCards, RecentlyClosed, ShopAlerts, type DashboardOrder } from "../components/flow/shop-dashboard";
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
    for (const text of ["Pages printed today", "1,234", "Completed order value today", "₹1,250"]) assert.ok(html.includes(text), `missing ${text}`);
  });
  it("a failed stats read shows an error with retry, never ₹0", () => {
    const html = renderToStaticMarkup(createElement(DailyStatsCards, { stats: null }));
    assert.ok(html.includes('role="alert"') && html.includes("Retry"));
    assert.ok(!html.includes("₹"));
  });
});

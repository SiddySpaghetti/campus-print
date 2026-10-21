/**
 * Today's totals for the shop dashboard. Both use timestamps that only the
 * orders_lifecycle trigger writes, once per order, on the status change
 * (shopkeepers can change status and status_reason only, see orders_guard):
 *  - pages printed: orders whose ready_at (PRINTING -> READY) falls today;
 *    READY can only move on to COMPLETED, so a printed order is never cancelled.
 *  - completed order value: orders whose completed_at (READY -> COMPLETED,
 *    handed over) falls today. Counter orders stay "unpaid" in the system, so
 *    this is order value, not confirmed money received.
 * "Today" is the Asia/Kolkata calendar day.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logServerError } from "@/lib/server/errors";

export type StatsRow = {
  shop_id: string;
  status: string;
  payment_status: string;
  total_pages: number;
  copies: number;
  total_paise: number;
  ready_at: string | null;
  completed_at: string | null;
};

export type DailyStats = { pagesPrinted: number; completedPaise: number };

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000; // India has no daylight saving

/** [start, end) of the Asia/Kolkata day containing `now`, as UTC ISO strings. */
export function istDayBounds(now: Date) {
  const start = Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

export function dailyStats(rows: StatsRow[], shopId: string, now: Date): DailyStats {
  const { start, end } = istDayBounds(now);
  const [from, to] = [Date.parse(start), Date.parse(end)];
  const today = (t: string | null) => t !== null && Date.parse(t) >= from && Date.parse(t) < to;

  let pagesPrinted = 0;
  let completedPaise = 0;
  for (const o of rows) {
    if (o.shop_id !== shopId) continue;
    if ((o.status === "READY" || o.status === "COMPLETED") && today(o.ready_at)) {
      pagesPrinted += o.total_pages * o.copies;
    }
    // A completed order refunded later (admin) is no longer value generated.
    if (o.status === "COMPLETED" && today(o.completed_at) && !o.payment_status.startsWith("REFUND")) {
      completedPaise += o.total_paise;
    }
  }
  return { pagesPrinted, completedPaise };
}

/** Runs as the shopkeeper (RLS). null = the read failed: show an error, never ₹0. */
export async function loadDailyStats(supabase: SupabaseClient, shopId: string, now = new Date()) {
  const { start, end } = istDayBounds(now);
  const { data, error, count } = await supabase
    .from("orders")
    .select("shop_id, status, payment_status, total_pages, copies, total_paise, ready_at, completed_at", { count: "exact" })
    .eq("shop_id", shopId)
    .or(`and(ready_at.gte.${start},ready_at.lt.${end}),and(completed_at.gte.${start},completed_at.lt.${end})`)
    .returns<StatsRow[]>();
  if (error || !data) {
    logServerError("shop-stats", error);
    return null;
  }
  // More rows than the API returned (row cap) would undercount: treat as failed.
  if ((count ?? 0) > data.length) return null;
  return dailyStats(data, shopId, now);
}

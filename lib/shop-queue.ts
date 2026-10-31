/**
 * The shop dashboard's order reads, split by lifecycle so a busy history can
 * never push an active order out of a fixed-size window:
 *  - active (PENDING..READY): every one, a page at a time, oldest first, with
 *    the file columns the queue's download buttons need;
 *  - closed (COMPLETED/CANCELLED/REJECTED): one page at a time, newest first,
 *    without files or print settings, which the closed list doesn't show.
 * Both run as the shopkeeper: RLS (orders_select_shop, order_files_select_shop)
 * limits them to their own shop on top of the shop_id filter.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type { DashboardOrder } from "@/components/flow/shop-dashboard";
import type { OrderStatus } from "@/components/flow/order-tracker";
import type { ColourMode, PaperSize, SideMode } from "@/lib/pricing";

export type ShopOrder = {
  id: string;
  order_number: string | null;
  status: OrderStatus;
  status_reason: string | null;
  payment_status: string;
  payment_method: string;
  colour_mode: ColourMode;
  paper_size: PaperSize;
  sides: SideMode;
  copies: number;
  total_pages: number;
  sheets: number;
  total_paise: number;
  student_note: string | null;
  created_at: string;
  order_files: { id: string; original_name: string; page_count: number; size_bytes: number; file_deleted_at: string | null }[];
};

export const ACTIVE: OrderStatus[] = ["PENDING", "ACCEPTED", "PRINTING", "READY"];
export const CLOSED: OrderStatus[] = ["COMPLETED", "CANCELLED", "REJECTED"];

/** Below PostgREST's max-rows (1000 on Supabase), so a page is never cut short by the server. */
export const ACTIVE_PAGE = 200;
export const CLOSED_PAGE = 30;

const ACTIVE_COLUMNS =
  "id, order_number, status, status_reason, payment_status, payment_method, colour_mode, paper_size, sides, copies, total_pages, sheets, total_paise, student_note, created_at, order_files(id, original_name, page_count, size_bytes, file_deleted_at)";
const CLOSED_COLUMNS = "id, order_number, status, status_reason, payment_status, payment_method, total_paise, created_at";

/**
 * Every active order of the shop, oldest first (the shop works in arrival
 * order). Throws on a failed read: a partial queue must not look complete.
 */
export async function loadActiveOrders(supabase: SupabaseClient, shopId: string | null) {
  const orders: ShopOrder[] = [];
  // ponytail: offset paging; an order closing between two pages can shift one
  // past the boundary until the next refresh. Keyset on (created_at, id) if
  // shops ever hold >200 active orders.
  for (;;) {
    const { data, error } = await supabase
      .from("orders")
      .select(ACTIVE_COLUMNS)
      .eq("shop_id", shopId)
      .in("status", ACTIVE)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(orders.length, orders.length + ACTIVE_PAGE - 1)
      .returns<ShopOrder[]>();
    if (error) throw error;
    orders.push(...(data ?? []));
    if ((data?.length ?? 0) < ACTIVE_PAGE) return orders;
  }
}

export type ClosedPage = { orders: DashboardOrder[]; hasOlder: boolean; error: PostgrestError | null };

/**
 * One page of closed orders, newest first. Asks for one row more than it
 * shows to learn whether an older page exists, instead of counting the
 * shop's whole history. Returns the error rather than throwing, so the caller
 * can start it early and throw where it renders.
 */
export async function loadClosedOrders(supabase: SupabaseClient, shopId: string | null, page: number): Promise<ClosedPage> {
  const from = page * CLOSED_PAGE;
  const { data, error } = await supabase
    .from("orders")
    .select(CLOSED_COLUMNS)
    .eq("shop_id", shopId)
    .in("status", CLOSED)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + CLOSED_PAGE)
    .returns<DashboardOrder[]>();
  const rows = data ?? [];
  return { orders: rows.slice(0, CLOSED_PAGE), hasOlder: rows.length > CLOSED_PAGE, error };
}

/** `?closed=` → a page index; anything odd is the first page. */
export function closedPageParam(value: string | string[] | undefined) {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : 0;
}

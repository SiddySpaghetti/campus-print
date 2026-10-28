import { FileText } from "lucide-react";

import { AutoRefresh, DownloadFileButton, ShopStatusActions } from "@/components/flow/order-actions";
import type { OrderStatus } from "@/components/flow/order-tracker";
import {
  DailyStatsCards,
  OrderHeader,
  PaidNotCompleted,
  RecentlyClosed,
  ShopAlerts,
  type DashboardOrder,
  type ShopAlert,
} from "@/components/flow/shop-dashboard";
import { Container } from "@/components/shared/section";
import { StaffHeader } from "@/components/shared/staff-header";
import { statusLabels } from "@/lib/orders";
import { formatPageCount, formatSheetCount } from "@/lib/page-count";
import { colourLabels, paperLabels, sidesLabels, type ColourMode, type PaperSize, type SideMode } from "@/lib/pricing";
import { requireRolePage } from "@/lib/server/auth";
import { loadDailyStats } from "@/lib/shop-stats";

type ShopOrder = {
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

const ACTIVE: OrderStatus[] = ["PENDING", "ACCEPTED", "PRINTING", "READY"];
const CLOSED: OrderStatus[] = ["COMPLETED", "CANCELLED", "REJECTED"];

export const metadata = { title: "Shop dashboard" };

/**
 * The shopkeeper's queue. Every read runs AS the shopkeeper: RLS
 * (orders_select_shop, order_files_select_shop, shops_select_own_shop) limits
 * it to their own shop, so another shop's orders can't appear here. Students
 * are identified only by order number — shops can't read student profiles.
 */
export default async function ShopDashboardPage() {
  const { supabase, user, shopId } = await requireRolePage("shopkeeper", "/shop");

  // The shop comes from the signed-in profile, never from the request; RLS
  // limits every read below to that shop as well.
  const [{ data: shop }, { data, error }, stats, unsettled, alerts] = await Promise.all([
    supabase.from("shops").select("name, is_open").eq("id", shopId).maybeSingle(),
    supabase
      .from("orders")
      .select(
        "id, order_number, status, status_reason, payment_status, payment_method, colour_mode, paper_size, sides, copies, total_pages, sheets, total_paise, student_note, created_at, order_files(id, original_name, page_count, size_bytes, file_deleted_at)",
      )
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<ShopOrder[]>(),
    shopId ? loadDailyStats(supabase, shopId) : null,
    // All of them, not capped by the 200 above: these must stay visible until settled.
    supabase
      .from("orders")
      .select("id, order_number, status, status_reason, payment_status, payment_method, total_paise, created_at, paid_at, cancelled_at")
      .eq("shop_id", shopId)
      .eq("payment_status", "REFUND_PENDING")
      .order("refund_requested_at", { ascending: true })
      .returns<DashboardOrder[]>(),
    // RLS (notifications_select_own): only this shopkeeper's own alerts.
    supabase
      .from("notifications")
      .select("id, type, title, body, created_at")
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<ShopAlert[]>(),
  ]);
  // A failed read must not look like an empty queue: app/error.tsx shows a retry.
  if (error) throw error;
  if (unsettled.error) throw unsettled.error;
  if (alerts.error) throw alerts.error;
  const orders = data ?? [];
  const count = (s: OrderStatus) => orders.filter((o) => o.status === s).length;
  // Oldest first in the queue, so the shop works in arrival order.
  const active = orders.filter((o) => ACTIVE.includes(o.status)).reverse();
  const closed = orders.filter((o) => CLOSED.includes(o.status)).slice(0, 30);

  return (
    <div className="flex min-h-dvh flex-col">
      <AutoRefresh />
      <StaffHeader area="Shop" email={user.email} />
      <main id="main">
        <Container className="pb-16 pt-8 md:pt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink">{shop?.name ?? "Your shop"}</h1>
            <span className="text-[13px] text-muted-foreground">{shop?.is_open ? "Open for orders" : "Closed to new orders"}</span>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {[...ACTIVE, ...CLOSED].map((s) => (
              <div key={s} className="rounded-card border border-line bg-card p-3">
                <dt className="text-[12px] text-muted-foreground">{statusLabels[s]}</dt>
                <dd className="font-mono text-xl font-semibold text-ink">{count(s)}</dd>
              </div>
            ))}
          </dl>

          <ShopAlerts alerts={alerts.data ?? []} />

          <h2 className="sr-only">Today</h2>
          <DailyStatsCards stats={stats} />

          <h2 className="mt-10 text-lg font-semibold text-ink">Active orders</h2>
          {active.length === 0 ? (
            <p className="mt-3 rounded-card border border-line bg-card p-5 text-[14px] text-muted-foreground">
              No active orders. New orders appear here automatically.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {active.map((o) => (
                <li key={o.id} className="rounded-card border border-line bg-card p-4 md:p-5">
                  <OrderHeader order={o} />
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    {formatPageCount(o.total_pages)} · {colourLabels[o.colour_mode]} · {paperLabels[o.paper_size]} ·{" "}
                    {sidesLabels[o.sides]} · {o.copies} {o.copies === 1 ? "copy" : "copies"} · {formatSheetCount(o.sheets)}
                  </p>
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {o.order_files.map((f) => (
                      <li key={f.id} className="flex min-w-0 items-center gap-2 text-[13px]">
                        <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        {f.file_deleted_at ? (
                          <span className="truncate text-muted-foreground">{f.original_name} (deleted)</span>
                        ) : (
                          <DownloadFileButton
                            fileId={f.id}
                            variant="link"
                            className="block h-auto max-w-full truncate text-left text-[13px] decoration-1"
                          >
                            {f.original_name}
                          </DownloadFileButton>
                        )}
                        <span className="shrink-0 text-muted-foreground">
                          {formatPageCount(f.page_count)} · {(f.size_bytes / 1024 / 1024).toFixed(1)} MB
                        </span>
                      </li>
                    ))}
                  </ul>
                  {o.student_note ? <p className="mt-2 text-[13px] text-ink">Note: {o.student_note}</p> : null}
                  <div className="mt-4">
                    <ShopStatusActions
                      orderId={o.id}
                      status={o.status}
                      paymentMethod={o.payment_method}
                      files={o.order_files.filter((f) => !f.file_deleted_at)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <PaidNotCompleted orders={unsettled.data ?? []} />
          <RecentlyClosed orders={closed} />
        </Container>
      </main>
    </div>
  );
}

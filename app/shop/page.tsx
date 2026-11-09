import { Suspense } from "react";
import { FileText } from "lucide-react";

import { DownloadFileButton, ShopOpenToggle, ShopStatusActions } from "@/components/flow/order-actions";
import { PrintOrder } from "@/components/flow/print-order";
import {
  DailyStatsCards,
  DailyStatsSkeleton,
  OrderHeader,
  PaidNotCompleted,
  RecentlyClosed,
  ShopAlerts,
  type DashboardOrder,
  type ShopAlert,
} from "@/components/flow/shop-dashboard";
import { ShopMonitor } from "@/components/flow/shop-monitor";
import { Container } from "@/components/shared/section";
import { StaffHeader } from "@/components/shared/staff-header";
import { awaitsPrintConfirmation, canOpenFiles, canPrint, shopStage, type ShopStage } from "@/lib/orders";
import { formatPageCount, formatSheetCount } from "@/lib/page-count";
import { colourLabels, paperLabels, sidesLabels } from "@/lib/pricing";
import { requireRolePage } from "@/lib/server/auth";
import { closedPageParam, loadActiveOrders, loadClosedOrders, type ClosedPage, type ShopOrder } from "@/lib/shop-queue";
import { loadDailyStats, type DailyStats } from "@/lib/shop-stats";

export const metadata = { title: "Shop dashboard" };

const QUEUE: { stage: ShopStage; title: string; hint?: string }[] = [
  { stage: "decide", title: "New orders to accept" },
  { stage: "print", title: "Ready to print" },
  { stage: "in_progress", title: "Printing and pickup" },
  { stage: "awaiting_payment", title: "Waiting for payment", hint: "Accepted, not paid yet. Documents unlock once payment is confirmed." },
];

/**
 * The shopkeeper's queue. Every read runs AS the shopkeeper: RLS
 * (orders_select_shop, order_files_select_shop, shops_select_own_shop) limits
 * it to their own shop, so another shop's orders can't appear here. Students
 * are identified only by order number — shops can't read student profiles.
 *
 * The queue renders first; today's totals and the closed list are started at
 * the same time but stream in behind their own Suspense boundaries.
 */
export default async function ShopDashboardPage({ searchParams }: PageProps<"/shop">) {
  const { supabase, user, shopId } = await requireRolePage("shopkeeper", "/shop");
  const closedPage = closedPageParam((await searchParams).closed);

  // The shop comes from the signed-in profile, never from the request; RLS
  // limits every read below to that shop as well. Neither of these rejects
  // (failures come back as values), so starting them early is safe.
  const stats = shopId ? loadDailyStats(supabase, shopId) : Promise.resolve(null);
  const closed = loadClosedOrders(supabase, shopId, closedPage);
  const [{ data: shop }, active, unsettled, alerts] = await Promise.all([
    supabase.from("shops").select("name, is_open").eq("id", shopId).maybeSingle(),
    loadActiveOrders(supabase, shopId),
    // All of them, however old: these must stay visible until settled.
    supabase
      .from("orders")
      .select("id, order_number, status, status_reason, payment_status, payment_method, total_paise, created_at, paid_after_cancel")
      .eq("shop_id", shopId)
      .eq("payment_status", "REFUND_PENDING")
      .order("refund_requested_at", { ascending: true })
      .returns<DashboardOrder[]>(),
    // The user filter lets the unread index do the work, instead of RLS sifting every user's rows.
    supabase
      .from("notifications")
      .select("id, type, title, body, created_at")
      .eq("user_id", user.id)
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<ShopAlert[]>(),
  ]);
  // A failed read must not look like an empty queue: app/error.tsx shows a retry.
  if (unsettled.error) throw unsettled.error;
  if (alerts.error) throw alerts.error;

  const inStage = (stage: ShopStage) => active.filter((o) => shopStage(o) === stage);
  const pendingCount = inStage("decide").length + inStage("print").length;

  return (
    <div className="flex min-h-dvh flex-col">
      <StaffHeader area="Shop" email={user.email} />
      <main id="main">
        <Container className="pb-16 pt-8 md:pt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink">{shop?.name ?? "Your shop"}</h1>
            {shop ? <ShopOpenToggle isOpen={shop.is_open} /> : null}
          </div>

          <div className="mt-4">
            <ShopMonitor userId={user.id} alerts={alerts.data ?? []} pendingCount={pendingCount} />
          </div>

          <h2 className="sr-only">Today</h2>
          <Suspense fallback={<DailyStatsSkeleton />}>
            <TodayStats stats={stats} />
          </Suspense>

          <ShopAlerts alerts={alerts.data ?? []} />

          {active.length === 0 ? (
            <>
              <h2 className="mt-10 text-lg font-semibold text-ink">Active orders</h2>
              <p className="mt-3 rounded-card border border-line bg-card p-5 text-[14px] text-muted-foreground">
                No active orders. New orders appear here automatically.
              </p>
            </>
          ) : (
            QUEUE.map(({ stage, title, hint }) => {
              const orders = inStage(stage);
              if (orders.length === 0) return null;
              return (
                <section key={stage} aria-labelledby={`queue-${stage}`}>
                  <h2 id={`queue-${stage}`} className="mt-10 text-lg font-semibold text-ink">
                    {title} ({orders.length})
                  </h2>
                  {hint ? <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p> : null}
                  <ul className="mt-3 flex flex-col gap-3">
                    {orders.map((o) => (
                      <li key={o.id} className="rounded-card border border-line bg-card p-4 md:p-5">
                        <OrderCard order={o} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}

          <PaidNotCompleted orders={unsettled.data ?? []} />
          <Suspense fallback={<div aria-busy="true" aria-label="Loading closed orders" className="mt-10 h-10 w-48 animate-pulse rounded-full border border-line bg-card" />}>
            <ClosedOrders closed={closed} page={closedPage} />
          </Suspense>
        </Container>
      </main>
    </div>
  );
}

function OrderCard({ order: o }: { order: ShopOrder }) {
  // Before payment a shop sees names, pages, settings and price, never contents.
  const openable = canOpenFiles(o);
  const printable = canPrint(o) && o.order_files.every((f) => !f.file_deleted_at);
  const copies = `${o.copies} ${o.copies === 1 ? "copy" : "copies"}`;
  const settings = `${copies} · ${sidesLabels[o.sides]} · ${colourLabels[o.colour_mode]} · ${paperLabels[o.paper_size]}`;
  return (
    <>
      <OrderHeader order={o} />
      <p className="mt-2 text-[13px] text-muted-foreground">
        {formatPageCount(o.total_pages)} · {colourLabels[o.colour_mode]} · {paperLabels[o.paper_size]} · {sidesLabels[o.sides]} · {copies} ·{" "}
        {formatSheetCount(o.sheets)}
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {o.order_files.map((f) => (
          <li key={f.id} className="flex min-w-0 items-center gap-2 text-[13px]">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {f.file_deleted_at ? (
              <span className="truncate text-muted-foreground">{f.original_name} (deleted)</span>
            ) : openable ? (
              <DownloadFileButton fileId={f.id} variant="link" className="block h-auto max-w-full truncate text-left text-[13px] decoration-1">
                {f.original_name}
              </DownloadFileButton>
            ) : (
              <span className="truncate text-ink">{f.original_name}</span>
            )}
            <span className="shrink-0 text-muted-foreground">
              {formatPageCount(f.page_count)} · {(f.size_bytes / 1024 / 1024).toFixed(1)} MB
            </span>
          </li>
        ))}
      </ul>
      {o.student_note ? <p className="mt-2 text-[13px] text-ink">Note: {o.student_note}</p> : null}
      {printable ? (
        <div className="mt-4">
          <PrintOrder
            orderId={o.id}
            confirms={awaitsPrintConfirmation(o)}
            paper={o.paper_size}
            sides={o.sides}
            settings={settings}
            files={o.order_files}
          />
        </div>
      ) : null}
      <div className="mt-4">
        <ShopStatusActions
          orderId={o.id}
          status={o.status}
          paymentMethod={o.payment_method}
          paymentStatus={o.payment_status}
          acceptFirst={o.accept_first}
        />
      </div>
    </>
  );
}

async function TodayStats({ stats }: { stats: Promise<DailyStats | null> }) {
  return <DailyStatsCards stats={await stats} />;
}

async function ClosedOrders({ closed, page }: { closed: Promise<ClosedPage>; page: number }) {
  const { orders, hasOlder, error } = await closed;
  if (error) throw error;
  return <RecentlyClosed orders={orders} page={page} hasOlder={hasOlder} />;
}

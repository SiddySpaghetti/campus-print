import { FileText } from "lucide-react";

import { AutoRefresh, ShopStatusActions } from "@/components/flow/order-actions";
import type { OrderStatus } from "@/components/flow/order-tracker";
import { Container } from "@/components/shared/section";
import { StaffHeader } from "@/components/shared/staff-header";
import { formatOrderDate, orderLabel, paymentLabel, statusLabels } from "@/lib/orders";
import { formatPageCount } from "@/lib/page-count";
import { colourLabels, formatRupees, paperLabels, sidesLabels, type ColourMode, type PaperSize, type SideMode } from "@/lib/pricing";
import { requireRolePage } from "@/lib/server/auth";

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

export const metadata = { title: "Shop dashboard · CampusPrint" };

/**
 * The shopkeeper's queue. Every read runs AS the shopkeeper: RLS
 * (orders_select_shop, order_files_select_shop, shops_select_own_shop) limits
 * it to their own shop, so another shop's orders can't appear here. Students
 * are identified only by order number — shops can't read student profiles.
 */
export default async function ShopDashboardPage() {
  const { supabase, user, shopId } = await requireRolePage("shopkeeper", "/shop");

  const [{ data: shop }, { data }] = await Promise.all([
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
  ]);
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
                    {sidesLabels[o.sides]} · {o.copies} {o.copies === 1 ? "copy" : "copies"} · {o.sheets} sheets
                  </p>
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {o.order_files.map((f) => (
                      <li key={f.id} className="flex min-w-0 items-center gap-2 text-[13px]">
                        <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        {f.file_deleted_at ? (
                          <span className="truncate text-muted-foreground">{f.original_name} (deleted)</span>
                        ) : (
                          <a
                            href={`/api/shop/files/${f.id}`}
                            className="truncate font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-ink"
                          >
                            {f.original_name}
                          </a>
                        )}
                        <span className="shrink-0 text-muted-foreground">
                          {formatPageCount(f.page_count)} · {(f.size_bytes / 1024 / 1024).toFixed(1)} MB
                        </span>
                      </li>
                    ))}
                  </ul>
                  {o.student_note ? <p className="mt-2 text-[13px] text-ink">Note: {o.student_note}</p> : null}
                  <div className="mt-4">
                    <ShopStatusActions orderId={o.id} status={o.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-10 text-lg font-semibold text-ink">Recently closed</h2>
          {closed.length === 0 ? (
            <p className="mt-3 text-[14px] text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {closed.map((o) => (
                <li key={o.id} className="rounded-card border border-line bg-card p-4">
                  <OrderHeader order={o} />
                  {o.status_reason ? <p className="mt-1 text-[13px] text-muted-foreground">Reason: {o.status_reason}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
    </div>
  );
}

function OrderHeader({ order }: { order: ShopOrder }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg font-semibold tracking-[-0.03em] text-ink">#{orderLabel(order)}</span>
        <span className="rounded-full bg-paper-deep px-2.5 py-0.5 text-[12px] font-medium text-ink">{statusLabels[order.status]}</span>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted-foreground">{paymentLabel(order)}</span>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-[12px] text-muted-foreground">{formatOrderDate(order.created_at)}</span>
        <span className="font-mono text-lg font-semibold text-ink">{formatRupees(order.total_paise / 100)}</span>
      </div>
    </div>
  );
}

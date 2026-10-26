import { ChevronDown } from "lucide-react";

import type { OrderStatus } from "@/components/flow/order-tracker";
import { buttonVariants } from "@/components/ui/button";
import { formatOrderDate, orderLabel, paymentLabel, statusLabels } from "@/lib/orders";
import { formatRupees } from "@/lib/pricing";
import type { DailyStats } from "@/lib/shop-stats";

export type DashboardOrder = {
  id: string;
  order_number: string | null;
  status: OrderStatus;
  status_reason: string | null;
  payment_status: string;
  payment_method: string;
  total_paise: number;
  created_at: string;
  /** Only read by PaidNotCompleted, to flag money captured after a cancellation. */
  paid_at?: string | null;
  cancelled_at?: string | null;
};

/** null = the read failed. Say so rather than show 0 / ₹0. */
export function DailyStatsCards({ stats }: { stats: DailyStats | null }) {
  if (!stats) {
    return (
      <p role="alert" className="mt-3 rounded-card border border-line bg-card p-4 text-[14px] text-muted-foreground">
        Couldn&apos;t load today&apos;s totals.{" "}
        <a href="/shop" className="font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-ink">
          Retry
        </a>
      </p>
    );
  }
  const cards = [
    { label: "Pages printed today", value: stats.pagesPrinted.toLocaleString("en-IN"), hint: "Orders marked ready today" },
    { label: "Completed order value today", value: formatRupees(stats.completedPaise / 100), hint: "Orders collected today" },
  ];
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2">
      {cards.map((c) => (
        <div key={c.label} className="min-w-0 rounded-card border border-line bg-card p-4">
          <dt className="text-[13px] font-medium text-ink">{c.label}</dt>
          <dd className="mt-1 font-mono text-2xl font-semibold tracking-[-0.03em] text-ink [overflow-wrap:anywhere]">{c.value}</dd>
          <dd className="mt-0.5 text-[12px] text-muted-foreground">{c.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Collapsed by default; native <details> gives keyboard + screen-reader expanded state. */
export function RecentlyClosed({ orders }: { orders: DashboardOrder[] }) {
  return (
    <details className="group mt-10">
      <summary className={buttonVariants({ variant: "outline", className: "list-none [&::-webkit-details-marker]:hidden" })}>
        Recently closed ({orders.length})
        <ChevronDown aria-hidden="true" className="transition-transform group-open:rotate-180" />
      </summary>
      {orders.length === 0 ? (
        <p className="mt-3 rounded-card border border-line bg-card p-5 text-[14px] text-muted-foreground">
          No closed orders yet. Collected, cancelled and rejected orders appear here.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {orders.map((o) => (
            <li key={o.id} className="rounded-card border border-line bg-card p-4">
              <OrderHeader order={o} />
              {o.status_reason ? <p className="mt-1 text-[13px] text-muted-foreground">Reason: {o.status_reason}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * Every paid order of this shop that was cancelled or rejected and has no
 * Razorpay-confirmed refund (REFUND_PENDING), however old: never just the
 * latest few, so none drops out of sight before it is settled.
 */
export function PaidNotCompleted({ orders }: { orders: DashboardOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <section aria-labelledby="paid-not-completed" className="mt-10">
      <h2 id="paid-not-completed" className="text-lg font-semibold text-ink">
        Paid, not completed ({orders.length})
      </h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        These were paid online, then cancelled or rejected. Nothing has been refunded automatically: settle each one
        with the student. If you refund it in your Razorpay dashboard, it shows as Refunded here once Razorpay confirms.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {orders.map((o) => (
          <li key={o.id} className="rounded-card border border-line bg-card p-4">
            <OrderHeader order={o} />
            {o.paid_at && o.cancelled_at && o.paid_at > o.cancelled_at ? (
              <p className="mt-1 text-[13px] font-medium text-ink">
                Paid after it was cancelled: nothing was printed. The student has been told to contact you.
              </p>
            ) : null}
            {o.status_reason ? <p className="mt-1 text-[13px] text-muted-foreground">Reason: {o.status_reason}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OrderHeader({ order }: { order: DashboardOrder }) {
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

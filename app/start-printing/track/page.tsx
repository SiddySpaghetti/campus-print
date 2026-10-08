import Link from "next/link";

import { AutoRefresh, CancelOrderButton } from "@/components/flow/order-actions";
import { OrderTracker, type OrderStatus } from "@/components/flow/order-tracker";
import { Container } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";
import { Button } from "@/components/ui/button";
import { canStudentCancel, FINAL_STATUSES, formatOrderDate, orderLabel, paymentLabels } from "@/lib/orders";
import { formatPageCount, formatSheetCount } from "@/lib/page-count";
import {
  colourLabels,
  formatRupees,
  paperLabels,
  sidesLabels,
  type ColourMode,
  type PaperSize,
  type SideMode,
} from "@/lib/pricing";
import { requireStudentPage } from "@/lib/server/auth";
import { isUuid } from "@/lib/server/validate";

type OrderRow = {
  id: string;
  order_number: string | null;
  shop_id: string;
  status: OrderStatus;
  status_reason: string | null;
  payment_status: string;
  colour_mode: ColourMode;
  paper_size: PaperSize;
  sides: SideMode;
  copies: number;
  total_pages: number;
  sheets: number;
  total_paise: number;
  created_at: string;
  order_files: { original_name: string }[];
};

const ORDER_COLUMNS =
  "id, order_number, shop_id, status, status_reason, payment_status, colour_mode, paper_size, sides, copies, total_pages, sheets, total_paise, created_at, order_files(original_name)";

/**
 * Tracking for one of the signed-in student's orders: `?order=<id>`, or their
 * latest order when no id is given. Reads run AS the user, so RLS
 * (orders_select_own) guarantees nobody can view someone else's order — an
 * unknown or foreign id simply finds nothing.
 */
export default async function TrackPage({ searchParams }: PageProps<"/start-printing/track">) {
  const { order: orderParam } = await searchParams;
  const { supabase } = await requireStudentPage("/start-printing/track");

  let query = supabase.from("orders").select(ORDER_COLUMNS);
  query = isUuid(orderParam)
    ? query.eq("id", orderParam)
    : query.order("created_at", { ascending: false }).limit(1);
  const { data: order } = await query.maybeSingle<OrderRow>();

  if (!order) {
    return (
      <Container className="py-24">
        <SectionHeading as="h1" title="Order not found" description="We couldn't find that order on your account." />
        <Button asChild size="lg" className="mt-8">
          <Link href="/start-printing">Start an order</Link>
        </Button>
      </Container>
    );
  }

  const { data: shop } = await supabase
    .from("public_shops")
    .select("name, prep_minutes")
    .eq("id", order.shop_id)
    .maybeSingle();

  const label = orderLabel(order);
  const final = FINAL_STATUSES.includes(order.status);
  const unpaid = order.status === "PENDING" && ["PENDING", "FAILED"].includes(order.payment_status);

  return (
    <Container className="pb-16 pt-8 md:pb-24 md:pt-12">
      {final ? null : <AutoRefresh />}
      <SectionHeading
        as="h1"
        eyebrow="Step 5 of 5"
        title={`Order #${label}`}
        description={shop ? `At ${shop.name} · usually ready in ~${shop.prep_minutes} min` : undefined}
      />

      {unpaid ? (
        <p className="mt-6 rounded-card border border-line bg-paper-deep p-4 text-[13px] text-muted-foreground">
          Development mode: this order is <span className="font-medium text-ink">unpaid</span>.
          Online payment isn&apos;t live yet, so the shop won&apos;t see it until it is.
        </p>
      ) : null}

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-8">
        <div className="flex h-fit flex-col gap-5 rounded-card border border-line bg-card p-5 md:p-6">
          <dl className="flex flex-col gap-2 text-[13px]">
            {order.order_files.map((f) => (
              <Detail key={f.original_name} label="Document" value={f.original_name} />
            ))}
            <Detail label="Pages" value={formatPageCount(order.total_pages)} />
            <Detail label="Colour" value={colourLabels[order.colour_mode]} />
            <Detail label="Paper" value={paperLabels[order.paper_size]} />
            <Detail label="Sides" value={sidesLabels[order.sides]} />
            <Detail label="Copies" value={`${order.copies} ${order.copies === 1 ? "copy" : "copies"}`} />
            <Detail label="Sheets" value={formatSheetCount(order.sheets)} />
            <Detail label="Placed" value={formatOrderDate(order.created_at)} />
            <Detail label="Payment" value={paymentLabels[order.payment_status] ?? order.payment_status} />
          </dl>

          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-4">
            <span className="text-sm text-muted-foreground">{unpaid ? "Total (unpaid)" : "Total"}</span>
            <span className="font-mono text-2xl font-semibold tracking-[-0.03em] text-ink">
              {formatRupees(order.total_paise / 100)}
            </span>
          </div>

          {canStudentCancel(order) ? <CancelOrderButton orderId={order.id} /> : null}
        </div>

        <div className="flex flex-col gap-5">
          <OrderTracker status={order.status} />
          {order.status_reason ? (
            <p className="text-[13px] text-muted-foreground">Reason: {order.status_reason}</p>
          ) : null}
          {final ? (
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link href="/start-printing">Start a new order</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </Container>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-ink">{value}</dd>
    </div>
  );
}

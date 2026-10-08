import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { OrderStatus } from "@/components/flow/order-tracker";
import { Reveal } from "@/components/shared/reveal";
import { Container } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";
import { Button } from "@/components/ui/button";
import { FINAL_STATUSES, formatOrderDate, orderLabel, paymentLabel, statusLabels } from "@/lib/orders";
import { formatPageCount } from "@/lib/page-count";
import { colourLabels, formatRupees, paperLabels, sidesLabels, type ColourMode, type PaperSize, type SideMode } from "@/lib/pricing";
import { requireStudentPage } from "@/lib/server/auth";
import { cn } from "@/lib/utils";

type OrderRow = {
  id: string;
  order_number: string | null;
  shop_id: string;
  status: OrderStatus;
  payment_status: string;
  payment_method: string;
  colour_mode: ColourMode;
  paper_size: PaperSize;
  sides: SideMode;
  copies: number;
  total_pages: number;
  total_paise: number;
  created_at: string;
};

/**
 * The signed-in student's orders, newest first. Read as the user, so RLS
 * (orders_select_own) is what limits this to their own orders.
 */
export default async function MyOrdersPage() {
  const { supabase } = await requireStudentPage("/orders");

  const { data } = await supabase
    .from("orders")
    .select("id, order_number, shop_id, status, payment_status, payment_method, colour_mode, paper_size, sides, copies, total_pages, total_paise, created_at")
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<OrderRow[]>();
  const orders = data ?? [];

  const shopIds = [...new Set(orders.map((o) => o.shop_id))];
  const { data: shops } = shopIds.length
    ? await supabase.from("public_shops").select("id, name").in("id", shopIds)
    : { data: [] };
  const shopName = new Map((shops ?? []).map((s) => [s.id as string, s.name as string]));

  return (
    <Container className="pb-16 pt-8 md:pb-24 md:pt-12">
      <SectionHeading as="h1" title="My orders" description="Everything you've sent to print, newest first." />

      {orders.length === 0 ? (
        <div className="mt-10 rounded-card border border-line bg-card p-6">
          <p className="text-[15px] text-muted-foreground">You haven&apos;t placed any orders yet.</p>
          <Button asChild size="lg" className="mt-5">
            <Link href="/start-printing">Start printing</Link>
          </Button>
        </div>
      ) : (
        <ul className="mt-10 flex flex-col gap-3">
          {orders.map((order, index) => (
            <li key={order.id}>
              <Reveal delay={Math.min(index, 6) * 0.04}>
                <Link
                  href={`/start-printing/track?order=${order.id}`}
                  className="group flex flex-col gap-4 rounded-card border border-line bg-card p-5 transition-colors hover:border-ink/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-lg font-semibold tracking-[-0.03em] text-ink">
                        #{orderLabel(order)}
                      </span>
                      <StatusPill status={order.status} />
                      <span className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted-foreground">
                        {paymentLabel(order)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-muted-foreground">
                      {shopName.get(order.shop_id) ?? "Shop"} · {formatOrderDate(order.created_at)}
                    </p>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {formatPageCount(order.total_pages)} · {colourLabels[order.colour_mode]} ·{" "}
                      {paperLabels[order.paper_size]} · {sidesLabels[order.sides]} · {order.copies}{" "}
                      {order.copies === 1 ? "copy" : "copies"}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-4 sm:justify-end">
                    <span className="font-mono text-xl font-semibold tracking-[-0.03em] text-ink">
                      {formatRupees(order.total_paise / 100)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[13px] font-medium text-ink">
                      Track
                      <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              </Reveal>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}

function StatusPill({ status }: { status: OrderStatus }) {
  const done = status === "READY" || status === "COMPLETED";
  const closed = FINAL_STATUSES.includes(status) && !done;
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[12px] font-medium",
        done
          ? "bg-[#e7f4eb] text-signal-ready"
          : closed
            ? "bg-paper-deep text-muted-foreground"
            : "bg-[#fdf3e2] text-signal-printing",
      )}
    >
      {statusLabels[status]}
    </span>
  );
}

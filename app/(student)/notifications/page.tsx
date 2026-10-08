import Link from "next/link";
import { Ban, Bell, CheckCircle2, CircleX, PackageCheck, Printer, Receipt, ThumbsUp } from "lucide-react";

import { AutoRefresh, MarkAllReadButton } from "@/components/flow/order-actions";
import { Reveal } from "@/components/shared/reveal";
import { Container } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";
import { formatOrderDate } from "@/lib/orders";
import { requireStudentPage } from "@/lib/server/auth";
import { cn } from "@/lib/utils";

type NotificationRow = {
  id: string;
  order_id: string | null;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

/** Types written by the orders_notify trigger. */
const icons: Record<string, typeof Bell> = {
  order_placed: Receipt,
  order_accepted: ThumbsUp,
  order_printing: Printer,
  order_ready: PackageCheck,
  order_completed: CheckCircle2,
  order_rejected: CircleX,
  order_cancelled: Ban,
  refund_issued: Receipt,
};

/**
 * The student's in-app notifications, created by database triggers when an
 * order changes. Read as the user: RLS (notifications_select_own) limits this
 * to their own rows.
 */
export default async function NotificationsPage() {
  const { supabase } = await requireStudentPage("/notifications");
  const { data } = await supabase
    .from("notifications")
    .select("id, order_id, type, title, body, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<NotificationRow[]>();
  const items = data ?? [];
  const unread = items.some((n) => !n.read_at);

  return (
    <Container className="pb-16 pt-8 md:pb-24 md:pt-12">
      <AutoRefresh />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading as="h1" title="Notifications" description="Updates from the shop about your orders." />
        {unread ? <MarkAllReadButton /> : null}
      </div>

      {items.length === 0 ? (
        <p className="mt-10 rounded-card border border-line bg-card p-6 text-[15px] text-muted-foreground">
          No notifications yet. You&apos;ll hear here when a shop accepts, prints or finishes your order.
        </p>
      ) : (
        <ul className="mt-10 flex flex-col gap-2">
          {items.map((n, index) => {
            const Icon = icons[n.type] ?? Bell;
            const body = (
              <div
                className={cn(
                  "flex items-start gap-3 rounded-card border p-4 transition-colors",
                  n.read_at ? "border-line bg-card" : "border-ink/20 bg-accent/15",
                  n.order_id && "hover:border-ink/30",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-deep text-ink"
                >
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[15px] font-medium text-ink">
                    {n.title}
                    {n.read_at ? null : (
                      <>
                        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-ink" />
                        <span className="sr-only">(unread)</span>
                      </>
                    )}
                  </p>
                  {n.body ? <p className="mt-0.5 text-[13px] text-muted-foreground">{n.body}</p> : null}
                  <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                    {formatOrderDate(n.created_at)}
                  </p>
                </div>
              </div>
            );
            return (
              <li key={n.id}>
                <Reveal delay={Math.min(index, 6) * 0.04}>
                  {n.order_id ? (
                    <Link
                      href={`/start-printing/track?order=${n.order_id}`}
                      className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </Reveal>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}

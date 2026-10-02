"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";

import { FlowShell } from "@/components/flow/flow-shell";
import { ORDER_TOKEN, useFlow } from "@/components/flow/flow-state";
import { OrderTracker } from "@/components/flow/order-tracker";
import { Button } from "@/components/ui/button";
import { formatPageCount } from "@/lib/page-count";
import { colourLabels, formatRupees, paperLabels, sidesLabels } from "@/lib/pricing";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export default function TrackPage() {
  const { shop, options, pageCount, price, orderStatus } = useFlow();
  const isReady = orderStatus === "ready";

  return (
    <FlowShell
      step="track"
      eyebrow="Step 6 of 6"
      title={`Order #${ORDER_TOKEN}`}
      description={shop ? `Printing at ${shop.name}.` : undefined}
      entrance="focus"
      hideFooter
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-8">
        {/* Order details */}
        <div className="flex h-fit flex-col gap-5 rounded-card border border-line bg-card p-5 md:p-6">
          <div>
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Order
            </p>
            <p className="mt-1 font-mono text-[34px] font-semibold leading-none tracking-[-0.04em] text-ink">
              #{ORDER_TOKEN}
            </p>
          </div>

          <dl className="flex flex-col gap-2 border-t border-line pt-4 text-[13px]">
            <Detail label="Shop" value={shop?.name ?? "—"} />
            <Detail label="Pages" value={formatPageCount(pageCount)} />
            <Detail label="Colour" value={colourLabels[options.colour]} />
            <Detail label="Paper" value={paperLabels[options.paper]} />
            <Detail label="Sides" value={sidesLabels[options.sides]} />
            <Detail
              label="Copies"
              value={`${options.copies} ${options.copies === 1 ? "copy" : "copies"}`}
            />
          </dl>

          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-4">
            <span className="text-sm text-muted-foreground">Paid</span>
            <span className="font-mono text-2xl font-semibold tracking-[-0.03em] text-ink">
              {formatRupees(price?.total ?? 0)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <OrderTracker />

          <AnimatePresence initial={false}>
            {isReady ? (
              <motion.div
                data-motion-static-self
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE_OUT }}
                className="rounded-card border border-line bg-accent/25 p-5 md:p-6"
              >
                <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-ink">
                  Your prints are ready.
                </h2>
                <p className="mt-1.5 text-[15px] text-muted-foreground">
                  {`Show Order #${ORDER_TOKEN} at the counter${shop ? ` at ${shop.name}` : ""}.`}
                </p>
                <Button asChild size="lg" className="mt-5 w-full sm:w-auto">
                  <Link href="/">Back to CampusPrint</Link>
                </Button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <p className="mt-8 text-[13px] text-muted-foreground">
        Demo tracking — the print job is simulated in your browser on a short timer.
      </p>
    </FlowShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

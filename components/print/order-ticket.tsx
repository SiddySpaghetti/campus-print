"use client";

import { useRef } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { Check, Printer } from "lucide-react";

import { LogoMark } from "@/components/shared/logo";
import { usePrintSimulation, PRINT_TIMING } from "@/components/print/use-print-simulation";
import { cn } from "@/lib/utils";
import {
  formatInr,
  orderSteps,
  type SampleOrder,
} from "@/lib/data/sample-order";

type OrderTicketProps = {
  order: SampleOrder;
  /** Shows a "Sample" tag so mock data is never mistaken for a real order. */
  isSample?: boolean;
  /** Loops a demo print job: pages count down, then "Ready for pickup". */
  animated?: boolean;
  className?: string;
};

type StatusView = "received" | "printing" | "ready";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * A CampusPrint order ticket: token, job summary, total, and a status
 * timeline toward pickup. Reusable later by the order-tracking section.
 */
export function OrderTicket({ order, isSample = false, animated = false, className }: OrderTicketProps) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const simulation = usePrintSimulation({
    totalPages: order.pages,
    active: animated && inView,
    staticProgress: order.progress,
  });

  // The looping demo only ever reports printing/ready; a static ticket shows
  // whatever stage the order is actually at, including "received".
  const status: StatusView = animated ? simulation.phase : order.status;
  const progress = animated ? simulation.progress : order.progress;
  const pagesShown = animated ? simulation.pagesLeft : order.pages;
  const activeIndex = orderSteps.findIndex((step) => step.id === status);
  const activeLabel = orderSteps[activeIndex]?.label ?? "";

  // Fill page-by-page in step with the countdown; snap back quickly on reset.
  const isResetting = animated && status === "printing" && simulation.pagesLeft === order.pages;
  const barTransition = !animated
    ? { delay: 0.9, duration: 1.4, ease: EASE_OUT }
    : isResetting
      ? { duration: 0.5, ease: EASE_OUT }
      : { duration: PRINT_TIMING.pageMs / 1000, ease: "linear" as const };

  return (
    <figure
      ref={ref}
      className={cn(
        "relative w-full max-w-[380px] overflow-hidden rounded-card border border-line bg-card shadow-[0_1px_0_rgb(17_17_17/0.04),0_24px_48px_-24px_rgb(17_17_17/0.22)]",
        className,
      )}
    >
      <figcaption className="sr-only">
        {isSample ? "Sample order ticket (illustration, not a real order)" : `Order ${order.token}`}
      </figcaption>

      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-2">
          <LogoMark className="size-6" />
          <span className="font-display text-[15px] font-semibold tracking-[-0.02em]">
            CampusPrint
          </span>
        </div>
        {isSample ? (
          <span className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Sample
          </span>
        ) : null}
      </div>

      {/* Token */}
      <div className="px-5 pb-5 pt-6">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Order
        </p>
        <p className="mt-1 font-mono text-[40px] font-semibold leading-none tracking-[-0.04em] text-ink">
          #{order.token}
        </p>
      </div>

      <Perforation />

      {/* Job details */}
      <dl className="grid grid-cols-3 gap-3 px-5 py-5">
        <Detail
          label="Pages"
          value={
            animated ? (
              <>
                <span className="sr-only">{order.pages}</span>
                <RollingNumber value={pagesShown} />
              </>
            ) : (
              String(order.pages)
            )
          }
        />
        <Detail label="Colour" value={order.colour} />
        <Detail label="Sides" value={order.sides} />
      </dl>

      <div className="mx-5 flex items-baseline justify-between border-t border-line pb-5 pt-4">
        <span className="text-sm text-muted-foreground">Paid</span>
        <span className="font-mono text-2xl font-semibold tracking-[-0.03em] text-ink">
          {formatInr(order.totalInr)}
        </span>
      </div>

      <Perforation />

      {/* Status */}
      <div className="px-5 pb-5 pt-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Status</span>
          <span className="sr-only">{activeLabel}</span>
          <StatusPill status={status} label={activeLabel} animated={animated} />
        </div>

        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-paper-deep" aria-hidden="true">
          <motion.div
            className="h-full origin-left rounded-full bg-ink"
            initial={{ scaleX: animated ? 0 : 0.08 }}
            animate={{ scaleX: progress }}
            transition={barTransition}
          />
        </div>

        <ol className="mt-4 grid grid-cols-3 gap-2">
          {orderSteps.map((step, index) => {
            const state =
              index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
            return (
              <li
                key={step.id}
                aria-current={state === "active" ? "step" : undefined}
                className={cn(
                  "flex flex-col gap-1.5 text-[12px] leading-tight transition-colors duration-300",
                  index === 1 && "items-center text-center",
                  index === 2 && "items-end text-right",
                  state === "pending" ? "text-muted-foreground" : "text-ink",
                )}
              >
                <StepDot state={state} />
                <span className={cn(state === "active" && "font-medium")}>
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <TicketFooter token={order.token} status={status} animated={animated} />
    </figure>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

/** Odometer-style number: the old value slides up and out as the new one arrives. */
function RollingNumber({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-[1.25em] min-w-[2ch] overflow-hidden tabular-nums"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          className="inline-block"
          initial={{ y: "70%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "-70%", opacity: 0 }}
          transition={{ duration: 0.32, ease: EASE_OUT }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Dashed tear line with half-circle notches cut into the ticket edges. */
function Perforation() {
  return (
    <div aria-hidden="true" className="relative h-0">
      <div className="mx-5 border-t border-dashed border-line" />
      <span className="absolute -left-2.5 top-0 size-5 -translate-y-1/2 rounded-full border border-line bg-paper" />
      <span className="absolute -right-2.5 top-0 size-5 -translate-y-1/2 rounded-full border border-line bg-paper" />
    </div>
  );
}

const pillColours = {
  received: { backgroundColor: "#f2f1ec", color: "#111111" },
  printing: { backgroundColor: "#fdf3e2", color: "#b45309" },
  ready: { backgroundColor: "#e7f4eb", color: "#15803d" },
} as const;

function StatusPill({
  status,
  label,
  animated,
}: {
  status: StatusView;
  label: string;
  animated: boolean;
}) {
  return (
    <motion.span
      aria-hidden="true"
      layout={animated}
      initial={false}
      animate={pillColours[status]}
      transition={{ duration: 0.35, ease: EASE_OUT }}
      className="inline-flex h-7 items-center overflow-hidden rounded-full px-3 text-[13px] font-medium"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={status}
          layout="position"
          className="inline-flex items-center gap-2 whitespace-nowrap"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3, ease: EASE_OUT }}
        >
          {status === "printing" ? (
            <>
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2 rounded-full bg-current" />
              </span>
              <PrinterWorking animated={animated} />
            </>
          ) : (
            <Check className="size-3.5" strokeWidth={2.75} />
          )}
          {label}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

/** Tiny printer that nudges once per page while a job is running. */
function PrinterWorking({ animated }: { animated: boolean }) {
  if (!animated) return <Printer className="size-3.5" />;
  return (
    <motion.span
      className="inline-flex"
      animate={{ y: [0, -1.5, 0] }}
      transition={{ duration: PRINT_TIMING.pageMs / 1000, repeat: Infinity, ease: "easeInOut" }}
    >
      <Printer className="size-3.5" />
    </motion.span>
  );
}

function StepDot({ state }: { state: "done" | "active" | "pending" }) {
  return (
    <span className="relative flex size-5" aria-hidden="true">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={state}
          className="absolute inset-0"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ duration: 0.3, ease: EASE_OUT }}
        >
          {state === "done" ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-ink text-paper">
              <Check className="size-3" strokeWidth={3} />
            </span>
          ) : state === "active" ? (
            <span className="flex size-5 items-center justify-center rounded-full border-2 border-ink bg-accent">
              <span className="size-1.5 rounded-full bg-ink" />
            </span>
          ) : (
            <span className="block size-5 rounded-full border-2 border-dashed border-line" />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Supporting line: the queue-free message while printing, pickup cue when ready. */
function TicketFooter({
  token,
  status,
  animated,
}: {
  token: string;
  status: StatusView;
  animated: boolean;
}) {
  if (!animated) {
    return (
      <p className="border-t border-dashed border-line bg-paper px-5 py-3 text-[12px] text-muted-foreground">
        Show <span className="font-mono font-medium text-ink">#{token}</span> at the counter to collect.
      </p>
    );
  }

  return (
    <div className="relative h-[43px] overflow-hidden border-t border-dashed border-line bg-paper px-5 text-[12px] text-muted-foreground">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.p
          key={status}
          className="flex h-full items-center gap-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.35, ease: EASE_OUT }}
        >
          {status === "printing" ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-accent ring-1 ring-ink/15" aria-hidden="true" />
              Printing while you skip the queue.
            </>
          ) : (
            <>
              <Check aria-hidden="true" className="size-3.5 shrink-0 text-signal-ready" strokeWidth={2.75} />
              <span>
                Ready. Show <span className="font-mono font-medium text-ink">#{token}</span> at the counter.
              </span>
            </>
          )}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

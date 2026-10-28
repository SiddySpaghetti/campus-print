"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { DrawCheck } from "@/components/flow/draw-check";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** public.order_status, in lifecycle order (CANCELLED/REJECTED end it early). */
export type OrderStatus =
  | "PENDING"
  | "ACCEPTED"
  | "PRINTING"
  | "READY"
  | "COMPLETED"
  | "CANCELLED"
  | "REJECTED";

const trackingSteps: { id: OrderStatus; label: string }[] = [
  { id: "PENDING", label: "Order placed" },
  { id: "ACCEPTED", label: "Shop accepted" },
  { id: "PRINTING", label: "Printing" },
  { id: "READY", label: "Ready for pickup" },
  { id: "COMPLETED", label: "Collected" },
];

const headline: Record<OrderStatus, string> = {
  PENDING: "Waiting for the shop",
  ACCEPTED: "Accepted",
  PRINTING: "Printing",
  READY: "Ready for pickup",
  COMPLETED: "Collected",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected by the shop",
};

/**
 * Shows the order's real status as stored in the database. Paid online orders
 * skip Accept (the shop's download starts printing), so `online` drops that
 * step — unless an older online order really is ACCEPTED.
 */
export function OrderTracker({ status, online = false }: { status: OrderStatus; online?: boolean }) {
  const reduced = useReducedMotion();
  const ended = status === "CANCELLED" || status === "REJECTED";
  const done = status === "READY" || status === "COMPLETED";
  const steps =
    online && status !== "ACCEPTED" ? trackingSteps.filter((step) => step.id !== "ACCEPTED") : trackingSteps;
  const activeIndex = steps.findIndex((step) => step.id === status);

  return (
    <div className="flex flex-col gap-5">
      <div
        className={cn(
          "rounded-card border bg-card p-5 transition-colors duration-500 md:p-6",
          done ? "border-signal-ready/35" : "border-line",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Status
            </p>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.p
                key={status}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.34, ease: EASE_OUT }}
                className="mt-1 font-display text-2xl font-semibold tracking-[-0.025em] text-ink md:text-3xl"
                aria-live="polite"
              >
                {headline[status]}
              </motion.p>
            </AnimatePresence>
          </div>

          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-[13px] font-medium",
              done
                ? "bg-[#e7f4eb] text-signal-ready"
                : ended
                  ? "bg-paper-deep text-muted-foreground"
                  : "bg-[#fdf3e2] text-signal-printing",
            )}
          >
            {done ? (
              <DrawCheck className="size-3.5" strokeWidth={3} />
            ) : ended ? null : (
              <span className="relative flex size-2">
                {reduced ? null : (
                  <span className="absolute inline-flex size-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
                )}
                <span className="relative inline-flex size-2 rounded-full bg-current" />
              </span>
            )}
            {done ? "Done" : ended ? "Closed" : "In progress"}
          </span>
        </div>
      </div>

      {ended ? null : (
        <ol className="flex flex-col rounded-card border border-line bg-card p-5 md:p-6">
          {steps.map((step, index) => {
            const state =
              index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
            const isLast = index === steps.length - 1;

            return (
              <li
                key={step.id}
                aria-current={state === "active" ? "step" : undefined}
                className="flex items-start gap-3"
              >
                <div className="flex flex-col items-center self-stretch">
                  <StepDot state={state} />
                  {isLast ? null : (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "w-px flex-1 transition-colors duration-500",
                        index < activeIndex ? "bg-ink/30" : "bg-line",
                      )}
                    />
                  )}
                </div>
                <p
                  className={cn(
                    "text-[15px] leading-5 transition-colors",
                    isLast ? "pb-0" : "pb-5",
                    state === "pending" ? "text-muted-foreground" : "text-ink",
                    state === "active" && "font-medium",
                  )}
                >
                  {step.label}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function StepDot({ state }: { state: "done" | "active" | "pending" }) {
  return (
    <span className="relative flex size-5 shrink-0">
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
              <DrawCheck className="size-3" strokeWidth={3.5} />
            </span>
          ) : state === "active" ? (
            <span className="flex size-5 items-center justify-center rounded-full border-2 border-ink bg-accent">
              <span className="size-1.5 rounded-full bg-ink" />
            </span>
          ) : (
            <span className="flex size-5 items-center justify-center rounded-full border border-line bg-card" />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

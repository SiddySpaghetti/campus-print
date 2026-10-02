"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { DrawCheck } from "@/components/flow/draw-check";
import { useFlow, type OrderStatus } from "@/components/flow/flow-state";
import { PrinterMachine } from "@/components/flow/printer-machine";
import { formatPageCount } from "@/lib/page-count";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Demo cadence: accepted at 1.4s, then a page every 420ms, then ready. */
const ACCEPT_MS = 1400;
const PAGE_MS = 420;

const trackingSteps: { id: OrderStatus; label: string }[] = [
  { id: "received", label: "Order received" },
  { id: "accepted", label: "Shop accepted" },
  { id: "printing", label: "Printing" },
  { id: "ready", label: "Ready for pickup" },
];

/**
 * Drives the one-way demo job: received, accepted, printing page by page, then
 * ready. Distinct from the hero ticket's looping simulation, which restarts
 * forever. Reduced-motion users land on the finished state instead of watching
 * the counter tick.
 */
export function OrderTracker() {
  const { pageCount, orderStatus, setOrderStatus } = useFlow();
  const reduced = useReducedMotion();
  const [pagesPrinted, setPagesPrinted] = useState(0);

  useEffect(() => {
    // Reduced motion (or coming back to a finished job): skip the theatre.
    if (reduced) {
      setOrderStatus("ready");
      return;
    }
    if (orderStatus === "ready") return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(setTimeout(() => setOrderStatus("accepted"), ACCEPT_MS));
    timers.push(setTimeout(() => setOrderStatus("printing"), ACCEPT_MS + 400));

    for (let page = 1; page <= pageCount; page++) {
      timers.push(
        setTimeout(() => setPagesPrinted(page), ACCEPT_MS + 400 + page * PAGE_MS),
      );
    }

    timers.push(
      setTimeout(
        () => setOrderStatus("ready"),
        ACCEPT_MS + 700 + pageCount * PAGE_MS,
      ),
    );

    return () => timers.forEach(clearTimeout);
    // Runs once per mount: the demo job shouldn't restart as status advances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, reduced]);

  const activeIndex = trackingSteps.findIndex((step) => step.id === orderStatus);
  const isReady = orderStatus === "ready";
  const isPrinting = orderStatus === "printing";
  // Derived, so a finished job always reads as complete without extra state.
  const pagesDone = isReady ? pageCount : pagesPrinted;
  const progress = pagesDone / pageCount;

  return (
    <div className="flex flex-col gap-5">
      <div
        className={cn(
          "relative overflow-hidden rounded-card border bg-card p-5 transition-colors duration-500 md:p-6",
          isReady ? "border-signal-ready/35" : "border-line",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Status
            </p>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.p
                key={isReady ? "ready" : "printing"}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.34, ease: EASE_OUT }}
                className="mt-1 font-display text-2xl font-semibold tracking-[-0.025em] text-ink md:text-3xl"
              >
                {isReady ? "Ready for pickup" : "Printing"}
              </motion.p>
            </AnimatePresence>
          </div>

          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-[13px] font-medium transition-colors duration-500",
              isReady
                ? "bg-[#e7f4eb] text-signal-ready"
                : "bg-[#fdf3e2] text-signal-printing",
            )}
          >
            {isReady ? (
              <DrawCheck className="size-3.5" strokeWidth={3} />
            ) : (
              // Pulsing dot while the job runs.
              <span className="relative flex size-2">
                {reduced ? null : (
                  <span className="absolute inline-flex size-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
                )}
                <span className="relative inline-flex size-2 rounded-full bg-current" />
              </span>
            )}
            {isReady ? "Done" : "In progress"}
          </span>
        </div>

        <p
          className="mt-4 font-mono text-[15px] text-muted-foreground"
          aria-live="polite"
        >
          <span className="font-semibold tabular-nums text-ink">{pagesDone}</span>{" "}
          / {formatPageCount(pageCount)}
        </p>

        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper-deep"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Printing progress"
        >
          {/* scaleX is the progress value, not an entrance offset, so this one
              deliberately skips `data-motion-static-self`. */}
          <motion.div
            className={cn(
              "h-full w-full origin-left rounded-full transition-colors duration-500",
              isReady ? "bg-signal-ready" : "bg-ink",
            )}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: progress }}
            transition={{ duration: PAGE_MS / 1000, ease: "linear" }}
          />
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <PrinterMachine
            pagesDone={pagesDone}
            running={isPrinting || (!isReady && activeIndex >= 0)}
            pageMs={PAGE_MS}
          />
        </div>
      </div>

      <ol className="flex flex-col rounded-card border border-line bg-card p-5 md:p-6">
        {trackingSteps.map((step, index) => {
          const state =
            index < activeIndex
              ? "done"
              : index === activeIndex
                ? "active"
                : "pending";
          const isLast = index === trackingSteps.length - 1;

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

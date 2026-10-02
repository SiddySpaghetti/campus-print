"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { DrawCheck } from "@/components/flow/draw-check";
import { OrderTicket } from "@/components/print/order-ticket";
import type { SampleOrder } from "@/lib/data/sample-order";
import { cn } from "@/lib/utils";

const WARMUP_MS = 480;
const FEED_MS = 1150;

type Phase = "warmup" | "feeding" | "settled";

/**
 * The confirmation ticket, printed rather than faded in.
 *
 * A printer unit sits above a clipping window; the ticket starts hidden behind
 * the slot and feeds downward through it, so the order number is the first
 * thing to appear. It settles with a little spring overshoot, then the paid
 * mark draws itself. Reduced motion skips straight to the settled ticket.
 */
export function PrintingTicket({
  order,
  onSettled,
  className,
}: {
  order: SampleOrder;
  onSettled?: () => void;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(reduced ? "settled" : "warmup");

  useEffect(() => {
    if (reduced) {
      onSettled?.();
      return;
    }

    const timers = [
      setTimeout(() => setPhase("feeding"), WARMUP_MS),
      setTimeout(() => {
        setPhase("settled");
        onSettled?.();
      }, WARMUP_MS + FEED_MS),
    ];

    return () => timers.forEach(clearTimeout);
    // Runs once; the sequence shouldn't restart if the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const working = phase === "warmup" || phase === "feeding";

  return (
    <div className={cn("relative mx-auto w-full max-w-[380px]", className)}>
      {/* Printer unit */}
      <div className="relative z-20 mx-auto flex h-10 w-[94%] items-center rounded-t-2xl rounded-b-sm border border-line bg-paper-deep px-3">
        <motion.span
          aria-hidden="true"
          className="size-1.5 rounded-full"
          animate={
            working && !reduced
              ? { backgroundColor: ["#b45309", "#d7f75b", "#b45309"] }
              : { backgroundColor: phase === "settled" ? "#15803d" : "#b45309" }
          }
          transition={
            working && !reduced
              ? { duration: 0.9, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.3 }
          }
        />
        <span className="ml-2 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {phase === "settled" ? "Printed" : "Printing"}
        </span>

        {/* Output slot */}
        <span
          aria-hidden="true"
          className="absolute bottom-[3px] left-1/2 h-[3px] w-[88%] -translate-x-1/2 rounded-full bg-ink/15"
        />
      </div>

      {/* Clipping window: the ticket is always laid out here, but sits above
          the top edge until it feeds through. */}
      <div className="relative z-10 overflow-hidden">
        <motion.div
          initial={reduced ? { y: 0 } : { y: "-100%" }}
          animate={{ y: phase === "warmup" ? "-100%" : 0 }}
          transition={
            reduced
              ? { duration: 0 }
              : { type: "spring", stiffness: 70, damping: 15, mass: 0.9 }
          }
        >
          <OrderTicket order={order} />
        </motion.div>
      </div>

      {/* Paid mark, once the ticket has landed */}
      <AnimatePresence initial={false}>
        {phase === "settled" ? (
          <motion.span
            aria-hidden="true"
            className="absolute -right-2 top-14 z-30 flex size-9 items-center justify-center rounded-full border border-ink bg-accent text-ink"
            initial={reduced ? { opacity: 0 } : { scale: 0.5, opacity: 0, rotate: -12 }}
            animate={{ scale: 1, opacity: 1, rotate: -8 }}
            transition={{ type: "spring", stiffness: 420, damping: 22, mass: 0.5 }}
          >
            <DrawCheck className="size-5" delay={0.12} strokeWidth={3} />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

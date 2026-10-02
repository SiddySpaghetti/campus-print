"use client";

import { useEffect, useState } from "react";
import { animate, useMotionValue, useReducedMotion } from "motion/react";

import { formatRupees } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * Price readout that counts from its old value to the new one, the way a
 * till re-totals a receipt, instead of swapping the number out.
 *
 * The motion value drives a formatted string in state so the digits stay
 * selectable text; reduced-motion users get the final value immediately.
 */
export function AnimatedTotal({
  amount,
  className,
}: {
  amount: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const value = useMotionValue(amount);
  const [shown, setShown] = useState(amount);

  useEffect(() => {
    // Reduced motion reads `amount` straight through (see `display` below),
    // so there's nothing to animate or sync here.
    if (reduced) return;

    const controls = animate(value, amount, {
      duration: 0.45,
      ease: [0.22, 1, 0.36, 1],
      // Whole rupees while it counts, so paise don't flicker past; the exact
      // total (which may have paise) lands at the end.
      onUpdate: (latest) => setShown(Math.round(latest)),
      onComplete: () => setShown(amount),
    });

    return () => controls.stop();
  }, [amount, reduced, value]);

  const display = reduced ? amount : shown;

  return (
    <span className={cn("tabular-nums", className)}>
      {/* The settled amount is what assistive tech announces. */}
      <span className="sr-only">{formatRupees(amount)}</span>
      <span aria-hidden="true">{formatRupees(display)}</span>
    </span>
  );
}

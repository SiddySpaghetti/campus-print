"use client";

import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * A checkmark that draws itself along its stroke rather than popping in.
 * Used for shop selection, payment success and the paid ticket.
 */
export function DrawCheck({
  className,
  delay = 0,
  duration = 0.4,
  strokeWidth = 3,
}: {
  className?: string;
  delay?: number;
  duration?: number;
  strokeWidth?: number;
}) {
  const reduced = useReducedMotion();

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
    >
      <motion.path
        d="M4.5 12.5 10 18 19.5 6.5"
        initial={reduced ? { pathLength: 1 } : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={
          reduced ? { duration: 0 } : { delay, duration, ease: [0.22, 1, 0.36, 1] }
        }
      />
    </svg>
  );
}

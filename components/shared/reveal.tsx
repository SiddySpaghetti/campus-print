"use client";

import { motion } from "motion/react";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

type RevealProps = React.ComponentProps<typeof motion.div> & {
  /** Stagger offset, in seconds. */
  delay?: number;
  /** Travel distance, in px. */
  y?: number;
};

/**
 * Fades its children up once they scroll into view. Shared by the sections
 * below the hero so entrance timing stays consistent; reduced-motion users get
 * the final state (MotionProvider + the [data-motion-static-self] fallback).
 */
export function Reveal({ delay = 0, y = 12, children, ...props }: RevealProps) {
  return (
    <motion.div
      data-motion-static-self
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ delay, duration: 0.4, ease: EASE_OUT }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

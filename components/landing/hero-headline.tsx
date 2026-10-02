"use client";

import { motion } from "motion/react";

import { TextEffect } from "@/components/motion-primitives/text-effect";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * "Print. Pay. / Pick up." fades up word by word, then the highlighter
 * stroke sweeps under "No queue." Reduced-motion users get the final state
 * (MotionProvider + the [data-motion-static] CSS fallback).
 */
export function HeroHeadline() {
  return (
    <h1
      data-motion-static
      className="isolate font-display text-[48px] font-semibold leading-[0.98] tracking-[-0.035em] text-ink sm:text-6xl lg:text-[80px]"
    >
      <TextEffect as="span" per="word" preset="fade-in-blur" speedSegment={0.6} className="block">
        Print. Pay.
      </TextEffect>{" "}
      <TextEffect as="span" per="word" preset="fade-in-blur" speedSegment={0.6} delay={0.15} className="block">
        Pick up.
      </TextEffect>{" "}
      <span className="relative mt-1 inline-block">
        <motion.span
          aria-hidden="true"
          className="absolute -inset-x-[0.12em] bottom-[0.06em] -z-10 h-[0.46em] origin-left -rotate-1 rounded-[0.12em] bg-accent"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ delay: 0.85, duration: 0.55, ease: EASE_OUT }}
        />
        <TextEffect as="span" per="word" preset="fade-in-blur" speedSegment={0.6} delay={0.4}>
          No queue.
        </TextEffect>
      </span>
    </h1>
  );
}

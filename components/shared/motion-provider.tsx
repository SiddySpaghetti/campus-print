"use client";

import { MotionConfig } from "motion/react";

/** Motion honours the OS "reduce motion" setting across the app. */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/** Timings for one demo cycle (~9.5s): hold at full → print each page → ready. */
export const PRINT_TIMING = {
  pageMs: 520,
  holdMs: 900,
  readyMs: 2400,
} as const;

export type PrintPhase = "printing" | "ready";

export type PrintSimulation = {
  phase: PrintPhase;
  pagesLeft: number;
  /** 0–1 share of pages printed. */
  progress: number;
};

type Options = {
  totalPages: number;
  /** Pause the loop (e.g. while the ticket is off-screen). */
  active: boolean;
  /** Frozen snapshot shown to reduced-motion users. */
  staticProgress: number;
};

/**
 * Drives the looping "pages are printing" demo on the order ticket.
 * One state update per page keeps CPU use negligible; the loop only runs
 * while `active`, and never runs for reduced-motion users.
 */
export function usePrintSimulation({ totalPages, active, staticProgress }: Options): PrintSimulation {
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<{ phase: PrintPhase; pagesLeft: number }>({
    phase: "printing",
    pagesLeft: totalPages,
  });

  const running = active && !reducedMotion;

  useEffect(() => {
    if (!running) return;

    let delay: number;
    let next: (s: typeof state) => typeof state;

    if (state.phase === "ready") {
      delay = PRINT_TIMING.readyMs;
      next = () => ({ phase: "printing", pagesLeft: totalPages });
    } else if (state.pagesLeft === 0) {
      delay = PRINT_TIMING.pageMs / 2;
      next = () => ({ phase: "ready", pagesLeft: 0 });
    } else {
      delay = state.pagesLeft === totalPages ? PRINT_TIMING.holdMs : PRINT_TIMING.pageMs;
      next = (s) => ({ ...s, pagesLeft: s.pagesLeft - 1 });
    }

    const timer = window.setTimeout(() => setState(next), delay);
    return () => window.clearTimeout(timer);
  }, [running, state, totalPages]);

  if (reducedMotion) {
    const pagesLeft = Math.round(totalPages * (1 - staticProgress));
    return { phase: "printing", pagesLeft, progress: (totalPages - pagesLeft) / totalPages };
  }

  return { ...state, progress: (totalPages - state.pagesLeft) / totalPages };
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Hydration-safe: the server snapshot is `false`, the client reads the media query. */
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  );
}

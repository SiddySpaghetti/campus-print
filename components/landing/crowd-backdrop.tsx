"use client";

import dynamic from "next/dynamic";

import type { CrowdCanvas } from "@/components/ui/skiper39";

/**
 * Decorative only: GSAP and the canvas code load in their own chunk after the
 * hero has rendered and hydrated (ssr: false needs a Client Component, hence
 * this file). If the chunk fails to load nothing is drawn, the hero never
 * depends on it; a sprite that fails to load already leaves the canvas blank.
 */
export const CrowdBackdrop = dynamic<React.ComponentProps<typeof CrowdCanvas>>(
  () => import("@/components/ui/skiper39").then((m) => m.CrowdCanvas, () => () => null),
  { ssr: false },
);

"use client";

import { motion, useReducedMotion } from "motion/react";
import { FileText } from "lucide-react";

import { cn } from "@/lib/utils";

/** How many output sheets the tray draws before it stops stacking. */
const MAX_TRAY = 8;

/**
 * Compact printing mechanism: the source document above, the printer body with
 * a moving head, and printed sheets stacking in the tray below.
 *
 *   DOCUMENT  →  [ PRINTER ]  →  printed pages
 *
 * The head sweeps and a sheet feeds while `running`; everything stops when the
 * job finishes. Reduced motion renders the same arrangement without the loops.
 */
export function PrinterMachine({
  pagesDone,
  running,
  pageMs,
}: {
  pagesDone: number;
  running: boolean;
  /** Milliseconds per page, so the sweep matches the counter. */
  pageMs: number;
}) {
  const reduced = useReducedMotion();
  const animating = running && !reduced;
  const sweep = pageMs / 1000;
  const trayCount = Math.min(pagesDone, MAX_TRAY);

  return (
    <div aria-hidden="true" className="flex flex-col items-center py-1">
      {/* Source document, nudging as it feeds */}
      <motion.span
        className="flex h-11 w-9 items-center justify-center rounded-sm border border-line bg-card text-muted-foreground"
        animate={animating ? { y: [0, 3, 0] } : { y: 0 }}
        transition={
          animating
            ? { duration: sweep * 2, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.3 }
        }
      >
        <FileText className="size-4" strokeWidth={1.5} />
      </motion.span>

      <Feeder active={animating} seconds={sweep} />

      {/* Printer body */}
      <div className="relative h-12 w-44 overflow-hidden rounded-xl border border-line bg-paper-deep">
        {/* Print head sweeping across */}
        <motion.span
          className="absolute left-2 top-2.5 h-1.5 w-7 rounded-full bg-ink/25"
          animate={animating ? { x: [0, 124, 0] } : { x: 0 }}
          transition={
            animating
              ? { duration: sweep * 2, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.35 }
          }
        />
        {/* Status light */}
        <motion.span
          className={cn(
            "absolute bottom-2.5 left-3 size-1.5 rounded-full",
            running ? "bg-signal-printing" : "bg-signal-ready",
          )}
          animate={animating ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
          transition={
            animating
              ? { duration: sweep, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.3 }
          }
        />
        {/* Output slot */}
        <span className="absolute bottom-1.5 left-1/2 h-[3px] w-28 -translate-x-1/2 rounded-full bg-ink/15" />
      </div>

      {/* Output tray: one sheet per printed page, slightly fanned */}
      <div className="relative mt-2 flex h-12 w-28 items-start justify-center">
        {Array.from({ length: trayCount }, (_, index) => (
          <motion.span
            key={index}
            className="absolute h-10 w-[4.5rem] rounded-sm border border-line bg-card"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -14 }}
            animate={{
              opacity: 1,
              y: index * 1.5,
              rotate: index % 2 === 0 ? -index * 0.8 : index * 0.8,
            }}
            transition={{ type: "spring", stiffness: 380, damping: 28, mass: 0.5 }}
            style={{ zIndex: index }}
          >
            <span className="ml-2 mt-2 block h-0.5 w-8 rounded-full bg-paper-deep" />
            <span className="ml-2 mt-1 block h-0.5 w-10 rounded-full bg-paper-deep" />
            <span className="ml-2 mt-1 block h-0.5 w-6 rounded-full bg-paper-deep" />
          </motion.span>
        ))}
        {pagesDone > MAX_TRAY ? (
          <span className="absolute -right-1 top-0 z-10 rounded-full border border-line bg-paper px-1.5 font-mono text-[9px] font-semibold text-muted-foreground">
            +{pagesDone - MAX_TRAY}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A short rail with a sheet travelling down it into the printer. */
function Feeder({ active, seconds }: { active: boolean; seconds: number }) {
  return (
    <span className="relative my-1 flex h-5 w-6 justify-center">
      <span className="h-full w-px bg-line" />
      <motion.span
        className="absolute left-1/2 top-0 h-2.5 w-4 -translate-x-1/2 rounded-[2px] border border-line bg-card"
        initial={{ opacity: 0 }}
        animate={active ? { y: [0, 14], opacity: [0, 1, 0] } : { opacity: 0 }}
        transition={
          active
            ? { duration: seconds, repeat: Infinity, ease: "easeIn" }
            : { duration: 0.2 }
        }
      />
    </span>
  );
}

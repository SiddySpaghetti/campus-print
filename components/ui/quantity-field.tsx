"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** How many sheets the stack draws before it stops growing visually. */
const MAX_STACK = 6;

type QuantityFieldProps = {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Accessible name, e.g. "Copies". */
  label: string;
  className?: string;
};

/**
 * Stepper for small counts, following the 21st.dev "Number Field" (#28180)
 * pattern — flanking increment/decrement buttons around a live value, with the
 * value exposed to assistive tech as a spinbutton.
 *
 * A small stack of sheets beside it gains or loses a sheet as you step, so the
 * control reads as physical copies rather than an abstract number.
 */
export function QuantityField({
  value,
  onValueChange,
  min = 1,
  max = 20,
  label,
  className,
}: QuantityFieldProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onValueChange(clamp(value + 1));
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onValueChange(clamp(value - 1));
    }
  };

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <PaperStack count={value} />

      <div className="inline-flex items-center gap-1 rounded-full border border-line bg-paper-deep p-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full bg-card hover:bg-card disabled:opacity-40"
          onClick={() => onValueChange(clamp(value - 1))}
          disabled={value <= min}
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          <Minus aria-hidden="true" className="size-4" />
        </Button>

        <span
          role="spinbutton"
          tabIndex={0}
          aria-label={label}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          onKeyDown={onKeyDown}
          className="relative inline-flex h-7 min-w-10 items-center justify-center overflow-hidden rounded-md text-[15px] font-medium tabular-nums text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={value}
              data-motion-static-self
              initial={{ y: "70%", opacity: 0 }}
              animate={{ y: "0%", opacity: 1 }}
              exit={{ y: "-70%", opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
            >
              {value}
            </motion.span>
          </AnimatePresence>
        </span>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full bg-card hover:bg-card disabled:opacity-40"
          onClick={() => onValueChange(clamp(value + 1))}
          disabled={value >= max}
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Sheets fanning upward, one per copy, capped so it never grows unbounded. */
function PaperStack({ count }: { count: number }) {
  const reduced = useReducedMotion();
  const sheets = Math.min(count, MAX_STACK);

  return (
    <span
      aria-hidden="true"
      className="relative hidden h-9 w-8 shrink-0 items-end justify-center sm:flex"
    >
      <AnimatePresence initial={false}>
        {Array.from({ length: sheets }, (_, index) => (
          <motion.span
            key={index}
            className="absolute bottom-0 h-7 w-6 rounded-[3px] border border-line bg-card"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.94 }}
            animate={{
              opacity: 1,
              y: -index * 2.5,
              scale: 1,
              rotate: index % 2 === 0 ? -index * 1.2 : index * 1.2,
            }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.94 }}
            transition={{
              type: "spring",
              stiffness: 460,
              damping: 30,
              mass: 0.45,
            }}
            style={{ zIndex: index }}
          />
        ))}
      </AnimatePresence>
      {count > MAX_STACK ? (
        <span className="absolute -right-1 -top-1 z-10 rounded-full border border-line bg-paper px-1 font-mono text-[9px] font-semibold leading-tight text-muted-foreground">
          {count}
        </span>
      ) : null}
    </span>
  );
}

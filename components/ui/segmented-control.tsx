"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";

import { cn } from "@/lib/utils";

// Adapted from 21st.dev "Segmented Control" (#23552, @ddoemonn): the
// radio-group semantics, arrow-key navigation and the masked sliding thumb
// that swaps label colour are kept. Restyled for CampusPrint — paper track,
// ink or lime thumb, no dark-mode variants — and the spring softened.
const THUMB_SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.5,
} as const;

const SEGMENT =
  "px-3 py-2 text-center text-[13px] font-medium leading-5 tracking-[-0.01em] whitespace-nowrap";

export type SegmentedOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SegmentedControlProps = {
  options: SegmentedOption[];
  /** Accessible name for the group. */
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** `accent` tints the thumb lime; `ink` is the default. */
  tone?: "ink" | "accent";
  className?: string;
};

export function SegmentedControl({
  options,
  label,
  value,
  defaultValue,
  onValueChange,
  tone = "ink",
  className,
}: SegmentedControlProps) {
  const count = Math.max(1, options.length);
  const template = `repeat(${count}, minmax(0, 1fr))`;

  const [internal, setInternal] = useState(
    () => defaultValue ?? options[0]?.value ?? "",
  );

  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const found = options.findIndex((option) => option.value === current);
  const index = found < 0 ? 0 : found;

  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const reduced = useReducedMotion();
  const position = useMotionValue(index);
  const thumbX = useTransform(position, (v) => `${v * 100}%`);
  const maskX = useTransform(position, (v) => `${v * -100}%`);

  useEffect(() => {
    if (reduced) {
      position.set(index);
      return;
    }
    const controls = animate(position, index, THUMB_SPRING);
    return () => controls.stop();
  }, [index, reduced, position]);

  // Called from event handlers only, so reading the prop directly is safe —
  // the upstream version kept it in a ref, which trips the refs lint rule.
  const select = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      if (next !== current) onValueChange?.(next);
    },
    [controlled, current, onValueChange],
  );

  const seek = useCallback(
    (from: number, direction: number) => {
      let i = from;
      for (let step = 0; step < count; step++) {
        i = (i + direction + count) % count;
        if (!options[i]?.disabled) return i;
      }
      return from;
    },
    [count, options],
  );

  const go = useCallback(
    (i: number) => {
      const option = options[i];
      if (!option || option.disabled) return;
      buttons.current[i]?.focus();
      select(option.value);
    },
    [options, select],
  );

  const onKeyDown = (event: React.KeyboardEvent, i: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      go(seek(i, 1));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      go(seek(i, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      go(seek(count - 1, 1));
    } else if (event.key === "End") {
      event.preventDefault();
      go(seek(0, -1));
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative block select-none rounded-full border border-line bg-paper-deep p-1",
        className,
      )}
    >
      <div
        className="relative grid"
        style={{ gridTemplateColumns: template, touchAction: "manipulation" }}
      >
        {/* Resting labels, revealed where the thumb isn't. */}
        {options.map((option, i) => (
          <span
            key={option.value}
            aria-hidden="true"
            className={cn(
              SEGMENT,
              "pointer-events-none",
              option.disabled
                ? "text-muted-foreground/50"
                : i === index
                  ? "text-muted-foreground"
                  : "text-muted-foreground",
            )}
          >
            {option.label}
          </span>
        ))}

        {/* Thumb carries its own copy of the labels, offset so the one under
            it lines up exactly — that's what inverts the text colour. */}
        {/* No `data-motion-static-self` here: the thumb's x encodes which
            option is selected, and that CSS fallback forces transform:none,
            which would strand it on the first option. Reduced motion is
            handled above by setting the position without animating. */}
        <motion.div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-full",
            tone === "accent"
              ? "bg-accent shadow-[inset_0_0_0_1px_rgb(17_17_17/0.08)]"
              : "bg-ink",
          )}
          style={{ width: `${100 / count}%`, x: thumbX }}
          initial={false}
        >
          <motion.div className="absolute inset-0" style={{ x: maskX }} initial={false}>
            <div
              className="absolute inset-y-0 left-0 grid"
              style={{ width: `${count * 100}%`, gridTemplateColumns: template }}
            >
              {options.map((option) => (
                <span
                  key={option.value}
                  className={cn(
                    SEGMENT,
                    tone === "accent" ? "text-ink" : "text-paper",
                  )}
                >
                  {option.label}
                </span>
              ))}
            </div>
          </motion.div>
        </motion.div>

        {/* The real controls sit on top, invisible but focusable. */}
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: template }}>
          {options.map((option, i) => (
            <button
              key={option.value}
              ref={(node) => {
                buttons.current[i] = node;
              }}
              type="button"
              role="radio"
              aria-checked={i === index}
              aria-disabled={option.disabled || undefined}
              tabIndex={i === index ? 0 : -1}
              onClick={() => !option.disabled && select(option.value)}
              onKeyDown={(event) => onKeyDown(event, i)}
              className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper-deep"
            >
              <span className="sr-only">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

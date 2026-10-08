"use client";

import { AnimatePresence, motion } from "motion/react";

import { DrawCheck } from "@/components/flow/draw-check";
import { PrintShopCard } from "@/components/print/print-shop-card";
import type { PrintShop } from "@/lib/data/print-shops";

const SETTLE = {
  type: "spring",
  stiffness: 420,
  damping: 30,
  mass: 0.6,
} as const;

/**
 * Selection behaviour for a shop card in the flow: the chosen card lifts, the
 * others settle back a touch, a single lime marker travels between cards
 * (one shared `layoutId`, so Motion tweens it across positions) and a
 * checkmark draws itself into the corner.
 *
 * Kept separate from PrintShopCard so that card stays Motion-free and can
 * still be rendered from the server on the landing page.
 */
export function ShopOption({
  shop,
  selected,
  onSelect,
  /** True once any shop is chosen, so unselected cards know to recede. */
  anySelected,
}: {
  shop: PrintShop;
  selected: boolean;
  /** Omitted for a closed shop: the card then shows no select action. */
  onSelect?: () => void;
  anySelected: boolean;
}) {
  return (
    <motion.div
      className="relative h-full"
      animate={{
        y: selected ? -6 : 0,
        scale: selected ? 1 : anySelected ? 0.99 : 1,
      }}
      transition={SETTLE}
    >
      <AnimatePresence initial={false}>
        {selected ? (
          <>
            {/* One marker for the whole list; it slides to the chosen card. */}
            <motion.span
              key="marker"
              aria-hidden="true"
              layoutId="shop-selection-marker"
              className="absolute inset-x-5 top-0 z-10 h-1 rounded-b-full bg-accent"
              transition={SETTLE}
            />
            <motion.span
              key="check"
              aria-hidden="true"
              className="absolute -right-2 -top-2 z-10 flex size-7 items-center justify-center rounded-full border border-ink bg-accent text-ink"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ ...SETTLE, damping: 22 }}
            >
              <DrawCheck className="size-4" delay={0.08} strokeWidth={3.5} />
            </motion.span>
          </>
        ) : null}
      </AnimatePresence>

      <PrintShopCard
        shop={shop}
        selected={selected}
        onSelect={onSelect}
        actionLabel={onSelect ? "Select shop" : "Closed now"}
        actionVariant="default"
      />
    </motion.div>
  );
}

"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { BadgeCheck, FileText, Store } from "lucide-react";

import { AnimatedTotal } from "@/components/flow/animated-total";
import { useFlow } from "@/components/flow/flow-state";
import { formatPageCount, formatSheetCount } from "@/lib/page-count";
import {
  colourLabels,
  fileKindLabel,
  formatFileSize,
  paperLabels,
  sidesLabels,
} from "@/lib/pricing";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Blocks arrive in reading order; the total lands last. */
const assembly = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.11, delayChildren: 0.05 } },
};

const blockIn = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT } },
};

/**
 * Live order summary. Shown beside the options controls and again on the
 * review screen, where each block gets an Edit link.
 *
 * With `assemble`, the blocks stack up one after another — shop, document,
 * settings, then the total — and `onAssembled` fires when the last one lands,
 * which the review screen uses to arm its CTA.
 */
export function OrderSummary({
  edits,
  assemble = false,
  onAssembled,
  className,
}: {
  /** Optional per-block edit links, used on the review screen. */
  edits?: { shop?: string; document?: string; options?: string };
  /** Stagger the blocks in rather than showing them at once. */
  assemble?: boolean;
  onAssembled?: () => void;
  className?: string;
}) {
  const { shop, file, options, pageCount, price } = useFlow();

  if (!shop) return null;

  return (
    <motion.div
      variants={assemble ? assembly : undefined}
      initial={assemble ? "hidden" : false}
      animate={assemble ? "shown" : undefined}
      onAnimationComplete={assemble ? onAssembled : undefined}
      className={cn(
        "flex flex-col gap-5 rounded-card border border-line bg-card p-5 md:p-6",
        className,
      )}
    >
      <Block label="Shop" assemble={assemble} editHref={edits?.shop} editLabel="Change shop">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-deep"
          >
            <Store className="size-4" strokeWidth={1.75} />
          </span>
          <div>
            <p className="flex items-center gap-1.5 font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">
              {shop.name}
              {shop.isVerified ? (
                <>
                  <BadgeCheck
                    aria-hidden="true"
                    className="size-4 shrink-0 fill-accent text-ink"
                    strokeWidth={1.75}
                  />
                  <span className="sr-only">Verified</span>
                </>
              ) : null}
            </p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Ready in ~{shop.prepMinutes} min
            </p>
          </div>
        </div>
      </Block>

      <Block label="Document" assemble={assemble} editHref={edits?.document} editLabel="Change document">
        {file ? (
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-deep"
            >
              <FileText className="size-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium text-ink">{file.name}</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {fileKindLabel(file)} · {formatFileSize(file.sizeBytes)} ·{" "}
                {formatPageCount(pageCount)}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">No document chosen yet.</p>
        )}
      </Block>

      <Block label="Print" assemble={assemble} editHref={edits?.options} editLabel="Edit options">
        <ul className="flex flex-wrap gap-1.5">
          {[
            colourLabels[options.colour],
            paperLabels[options.paper],
            sidesLabels[options.sides],
            `${options.copies} ${options.copies === 1 ? "copy" : "copies"}`,
          ].map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-line bg-paper-deep px-2.5 py-1 text-[12px] font-medium text-ink"
            >
              {chip}
            </li>
          ))}
        </ul>
      </Block>

      <motion.div
        variants={assemble ? blockIn : undefined}
        className="flex items-baseline justify-between gap-3 border-t border-line pt-4"
      >
        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Total
          </p>
          {price ? (
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {formatSheetCount(price.sheets)} ·{" "}
            {new Intl.NumberFormat("en-IN", {
              style: "currency",
              currency: "INR",
              minimumFractionDigits: Number.isInteger(price.ratePerSheet) ? 0 : 2,
            }).format(price.ratePerSheet)}{" "}
            each
          </p>
          ) : (
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Not offered at this shop
            </p>
          )}
        </div>
        {price ? (
          <AnimatedTotal
            amount={price.total}
            className="font-mono text-[28px] font-semibold leading-none tracking-[-0.03em] text-ink"
          />
        ) : null}
      </motion.div>
    </motion.div>
  );
}

function Block({
  label,
  assemble,
  editHref,
  editLabel,
  children,
}: {
  label: string;
  assemble: boolean;
  editHref?: string;
  editLabel: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section variants={assemble ? blockIn : undefined}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </h2>
        {editHref ? (
          <Link
            href={editHref}
            className="rounded-full text-[13px] font-medium text-ink underline decoration-line decoration-2 underline-offset-4 transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {editLabel}
          </Link>
        ) : null}
      </div>
      {children}
    </motion.section>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";

import { DrawCheck } from "@/components/flow/draw-check";
import { ORDER_TOKEN, useFlow } from "@/components/flow/flow-state";
import { PrintingTicket } from "@/components/flow/printing-ticket";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/shared/section";
import { colourLabels, paperLabels, sidesLabels } from "@/lib/pricing";
import { formatPageCount } from "@/lib/page-count";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Seconds on screen before tracking opens by itself. */
const AUTO_ADVANCE_SECONDS = 5;

export default function SuccessPage() {
  const router = useRouter();
  const { ready, shop, file, options, pageCount, price, paymentStatus } = useFlow();

  const [settled, setSettled] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_ADVANCE_SECONDS);
  const [paused, setPaused] = useState(false);

  // Only reachable once the demo payment has gone through.
  useEffect(() => {
    if (ready && paymentStatus !== "paid") router.replace("/start-printing");
  }, [ready, paymentStatus, router]);

  // The countdown starts after the ticket has printed, and pauses while the
  // pointer or keyboard focus is on the actions, so nobody is yanked away
  // mid-read.
  useEffect(() => {
    if (!settled || paused) return;
    if (secondsLeft <= 0) {
      router.replace("/start-printing/track");
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [settled, paused, secondsLeft, router]);

  if (!ready || paymentStatus !== "paid" || !shop || !price) {
    return (
      <Container className="py-24">
        <p className="text-sm text-muted-foreground">Loading your order…</p>
      </Container>
    );
  }

  return (
    <Container className="flex flex-col items-center pb-20 pt-10 text-center md:pb-28 md:pt-14">
      {/* Payment outcome */}
      <motion.p
        className="inline-flex items-center gap-2 rounded-full bg-[#e7f4eb] px-3 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-signal-ready"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT }}
      >
        <DrawCheck className="size-3.5" delay={0.15} strokeWidth={3.5} />
        Payment successful
      </motion.p>

      <motion.h1
        className="mt-5 font-display text-3xl font-semibold leading-[1.05] tracking-[-0.025em] text-ink md:text-4xl"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.34, delay: 0.08, ease: EASE_OUT }}
      >
        Your order is confirmed.
      </motion.h1>

      <motion.p
        className="mt-3 max-w-md text-base leading-relaxed text-muted-foreground text-pretty"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.16 }}
      >
        {`Sent to ${shop.name}. Keep your order number handy for pickup.`}
      </motion.p>

      {/* The ticket prints itself */}
      <PrintingTicket
        className="mt-9"
        onSettled={() => setSettled(true)}
        order={{
          token: ORDER_TOKEN,
          pages: pageCount,
          colour: colourLabels[options.colour],
          sides: sidesLabels[options.sides],
          totalInr: price.total,
          status: "received",
          progress: 0.06,
        }}
      />

      {/* Order details the ticket doesn't carry */}
      <motion.dl
        className="mt-7 flex flex-col items-center gap-1 text-[13px] text-muted-foreground"
        initial={{ opacity: 0, y: 6 }}
        animate={settled ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
        transition={{ duration: 0.32, ease: EASE_OUT }}
      >
        {file ? (
          <div>
            <dt className="sr-only">Document</dt>
            <dd className="font-medium text-ink">{file.name}</dd>
          </div>
        ) : null}
        <div>
          <dt className="sr-only">Print settings</dt>
          <dd>
            {formatPageCount(pageCount)} · {colourLabels[options.colour]} ·{" "}
            {paperLabels[options.paper]} · {sidesLabels[options.sides]} ·{" "}
            {options.copies} {options.copies === 1 ? "copy" : "copies"}
          </dd>
        </div>
      </motion.dl>

      {/* Actions */}
      <motion.div
        className="mt-9 flex w-full flex-col items-center gap-3 sm:w-auto"
        initial={{ opacity: 0 }}
        animate={settled ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
      >
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Button asChild size="lg" className="group w-full sm:w-auto">
            <Link href="/start-printing/track">
              Next: Track order
              <ArrowRight
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:translate-x-1"
              />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
            <Link href="/">Back to CampusPrint</Link>
          </Button>
        </div>

        {/* Subtle auto-advance: a thin line draining, plus the seconds. */}
        <div className="flex h-5 items-center gap-2" aria-live="off">
          {settled && secondsLeft > 0 ? (
            <>
              <span className="relative h-px w-16 overflow-hidden bg-line">
                <motion.span
                  className="absolute inset-y-0 left-0 w-full origin-left bg-muted-foreground/50"
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: paused ? 1 : 0 }}
                  transition={{
                    duration: paused ? 0 : secondsLeft,
                    ease: "linear",
                  }}
                />
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {paused
                  ? "Paused"
                  : `Tracking opens in ${secondsLeft}s`}
              </span>
            </>
          ) : null}
        </div>
      </motion.div>

      <p className="mt-6 text-[13px] text-muted-foreground">
        Demo order — nothing was charged and no shop was contacted.
      </p>
    </Container>
  );
}

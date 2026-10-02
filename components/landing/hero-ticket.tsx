"use client";

import { motion } from "motion/react";

import { OrderTicket } from "@/components/print/order-ticket";
import { sampleOrder } from "@/lib/data/sample-order";

/** Hero visual: the sample ticket resting on a printed sheet. */
export function HeroTicket() {
  return (
    <div className="relative mx-auto w-full max-w-[380px] lg:mr-0">
      {/* The printout behind the ticket */}
      <div
        aria-hidden="true"
        className="absolute inset-x-6 -top-4 bottom-10 rotate-[-4deg] rounded-card border border-line bg-card p-6 shadow-[0_16px_40px_-24px_rgb(17_17_17/0.18)]"
      >
        <div className="flex flex-col gap-2.5">
          <span className="h-2 w-2/3 rounded-full bg-paper-deep" />
          <span className="h-2 w-full rounded-full bg-paper-deep" />
          <span className="h-2 w-5/6 rounded-full bg-paper-deep" />
          <span className="h-2 w-3/4 rounded-full bg-paper-deep" />
        </div>
      </div>

      <motion.div
        data-motion-static-self
        className="relative lg:rotate-[1.5deg]"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        <OrderTicket order={sampleOrder} isSample animated />
      </motion.div>
    </div>
  );
}

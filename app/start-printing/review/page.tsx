"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

import { FlowShell } from "@/components/flow/flow-shell";
import { OrderSummary } from "@/components/flow/order-summary";

export default function ReviewPage() {
  const reduced = useReducedMotion();
  // The CTA arms once the summary has finished assembling, so people see the
  // whole order before they can move on. Reduced motion skips the wait.
  const [assembled, setAssembled] = useState(reduced);

  // Safety net: the assembly takes ~0.7s, so arm the CTA regardless by 1.5s.
  // A missed animation callback must never leave a permanently dead button.
  useEffect(() => {
    const timer = setTimeout(() => setAssembled(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <FlowShell
      step="review"
      eyebrow="Step 4 of 6"
      title="Review your order"
      description="Check everything over before you pay. You can still change any part of it."
      entrance="assemble"
      back={{ href: "/start-printing/options" }}
      next={{
        label: "Continue to payment",
        href: "/start-printing/payment",
        disabled: !assembled,
      }}
    >
      <div className="mx-auto max-w-xl">
        <OrderSummary
          assemble={!reduced}
          onAssembled={() => setAssembled(true)}
          edits={{
            shop: "/start-printing",
            document: "/start-printing/upload",
            options: "/start-printing/options",
          }}
        />
      </div>
    </FlowShell>
  );
}

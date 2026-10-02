"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Check } from "lucide-react";

import { flowSteps, useFlow, type FlowStepId } from "@/components/flow/flow-state";
import { cn } from "@/lib/utils";

/**
 * Horizontal step rail across the top of the flow, following the 21st.dev
 * "Stepper / with-checkmarks" (#761) and "Checkout Steps Breadcrumb" (#18876)
 * pattern: numbered nodes, checkmarks behind you, a connecting rule.
 *
 * Completed steps are links so you can go back; steps whose prerequisites
 * aren't met render as plain text and can't be jumped to.
 */
export function FlowSteps() {
  const pathname = usePathname();
  const { canAccess, completedSteps, paymentStatus } = useFlow();
  const paid = paymentStatus === "paid";

  // /success sits between payment and track, so treat it as the payment step.
  const activeId: FlowStepId = pathname.endsWith("/success")
    ? "payment"
    : (flowSteps.find((step) => step.href === pathname)?.id ?? "shop");
  const activeIndex = flowSteps.findIndex((step) => step.id === activeId);

  return (
    <nav aria-label="Print flow progress" className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ol className="flex min-w-max items-center gap-1 py-3 md:gap-2">
        {flowSteps.map((step, index) => {
          const isActive = step.id === activeId;
          const isDone = completedSteps[step.id] && index < activeIndex;
          // Once paid, the pre-payment steps are history — they stop being
          // links so the rail can't send anyone back into a completed order.
          const settled = paid && step.id !== "payment" && step.id !== "track";
          const reachable = canAccess(step.id) && !isActive && !settled;

          const body = (
            <span
              className={cn(
                "flex items-center gap-2 rounded-full px-2.5 py-1.5 transition-colors",
                isActive
                  ? "text-ink"
                  : reachable
                    ? "text-muted-foreground hover:bg-paper-deep hover:text-ink"
                    : "text-muted-foreground/60",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums transition-colors",
                  isDone
                    ? "border-ink bg-ink text-paper"
                    : isActive
                      ? "border-ink bg-accent text-ink"
                      : "border-line bg-card text-muted-foreground",
                )}
              >
                {isDone ? <Check className="size-3" strokeWidth={3} /> : index + 1}
              </span>
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em]">
                {step.label}
              </span>
            </span>
          );

          return (
            <li key={step.id} className="flex items-center gap-1 md:gap-2">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-px w-4 shrink-0 md:w-6",
                    index <= activeIndex ? "bg-ink/25" : "bg-line",
                  )}
                />
              ) : null}

              {reachable ? (
                <Link
                  href={step.href}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Back to ${step.label}`}
                >
                  {body}
                </Link>
              ) : (
                <span aria-current={isActive ? "step" : undefined} className="relative">
                  {body}
                  {isActive ? (
                    <motion.span
                      aria-hidden="true"
                      data-motion-static-self
                      layoutId="flow-step-underline"
                      className="absolute inset-x-2.5 -bottom-0.5 h-0.5 rounded-full bg-accent"
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    />
                  ) : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

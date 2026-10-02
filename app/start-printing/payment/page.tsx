"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Banknote, CreditCard, Smartphone } from "lucide-react";

import { DrawCheck } from "@/components/flow/draw-check";
import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow, type PaymentMethod } from "@/components/flow/flow-state";
import { Button } from "@/components/ui/button";
import { formatRupees } from "@/lib/pricing";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Processing runs, then the success state is held long enough to read. */
const PROCESSING_MS = 1600;
const SUCCESS_HOLD_MS = 1200;

const methods: {
  id: PaymentMethod;
  label: string;
  hint: string;
  icon: typeof Smartphone;
}[] = [
  { id: "upi", label: "UPI", hint: "Pay from any UPI app", icon: Smartphone },
  { id: "card", label: "Card", hint: "Debit or credit card", icon: CreditCard },
  { id: "cash", label: "Cash at shop", hint: "Pay when you collect", icon: Banknote },
];

type Stage = "idle" | "processing" | "done";

export default function PaymentPage() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const { price, paymentMethod, setPaymentMethod, paymentStatus, setPaymentStatus } =
    useFlow();
  const [stage, setStage] = useState<Stage>(
    paymentStatus === "paid" ? "done" : "idle",
  );
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const pay = () => {
    if (stage !== "idle") return;

    setStage("processing");
    setPaymentStatus("processing");

    const processing = reduced ? 500 : PROCESSING_MS;
    const hold = reduced ? 700 : SUCCESS_HOLD_MS;

    timers.current.push(
      setTimeout(() => {
        setStage("done");
        setPaymentStatus("paid");
      }, processing),
    );
    // Forward to the confirmation — never back to review. `replace` keeps the
    // paid order out of history, so Back can't land on the payment form again.
    timers.current.push(
      setTimeout(() => router.replace("/start-printing/success"), processing + hold),
    );
  };

  const total = price?.total ?? 0;

  return (
    <FlowShell
      step="payment"
      eyebrow="Step 5 of 6"
      title="Payment"
      description="This is a demo checkout. No payment is taken and no card details are collected."
      entrance="focus"
      hideFooter
    >
      <div className="mx-auto max-w-xl">
        <div className="rounded-card border border-line bg-card p-5 md:p-6">
          <div className="flex items-baseline justify-between gap-4 border-b border-line pb-5">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Amount due
            </span>
            <span className="font-mono text-[32px] font-semibold leading-none tracking-[-0.03em] text-ink">
              {formatRupees(total)}
            </span>
          </div>

          <fieldset className="mt-5" disabled={stage !== "idle"}>
            <legend className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Payment method
            </legend>
            <div
              role="radiogroup"
              aria-label="Payment method"
              className="mt-3 flex flex-col gap-2"
            >
              {methods.map((method) => {
                const Icon = method.icon;
                const active = method.id === paymentMethod;

                return (
                  <button
                    key={method.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setPaymentMethod(method.id)}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 rounded-2xl border p-4 text-left transition-[border-color,background-color] duration-200",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      "disabled:cursor-default disabled:opacity-60",
                      active
                        ? "border-ink bg-paper-deep"
                        : "border-line bg-card hover:border-ink/25",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-card text-ink"
                    >
                      <Icon className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <span className="flex-1">
                      <span className="block font-medium text-ink">{method.label}</span>
                      <span className="block text-[13px] text-muted-foreground">
                        {method.hint}
                      </span>
                    </span>
                    {/* One dot travels to the chosen method. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                        active ? "border-ink bg-accent" : "border-line bg-card",
                      )}
                    >
                      {active ? (
                        <motion.span
                          layoutId="payment-method-dot"
                          className="size-1.5 rounded-full bg-ink"
                          transition={{
                            type: "spring",
                            stiffness: 480,
                            damping: 32,
                            mass: 0.5,
                          }}
                        />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-6 min-h-12">
            <AnimatePresence initial={false} mode="wait">
              {stage === "idle" ? (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <Button size="lg" className="w-full" onClick={pay}>
                    {`Pay ${formatRupees(total)}`}
                  </Button>
                </motion.div>
              ) : stage === "processing" ? (
                <motion.div
                  key="processing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex h-12 items-center justify-center gap-3 rounded-full bg-paper-deep text-[15px] font-medium text-muted-foreground"
                  aria-live="polite"
                >
                  <ProcessingDots animate={!reduced} />
                  Payment processing
                </motion.div>
              ) : (
                <motion.div
                  key="done"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                  className="flex h-12 items-center justify-center gap-2.5 rounded-full bg-[#e7f4eb] text-[15px] font-medium text-signal-ready"
                  aria-live="polite"
                >
                  <motion.span
                    aria-hidden="true"
                    className="inline-flex size-5 items-center justify-center rounded-full bg-signal-ready text-white"
                    initial={{ scale: 0.6 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.3, ease: EASE_OUT }}
                  >
                    <DrawCheck className="size-3.5" delay={0.1} strokeWidth={3.5} />
                  </motion.span>
                  Payment successful
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Back is available until the payment starts, and only then. */}
        {stage === "idle" ? (
          <div className="mt-5 flex justify-center">
            <Button asChild variant="ghost" size="sm">
              <Link href="/start-printing/review">
                <ArrowLeft aria-hidden="true" />
                Back to review
              </Link>
            </Button>
          </div>
        ) : null}

        <p className="mt-4 text-[13px] text-muted-foreground">
          Demo only — this prototype simulates the payment locally and never contacts a
          payment provider.
        </p>
      </div>
    </FlowShell>
  );
}

/** Three dots filling in turn, like a terminal waiting on an authorisation. */
function ProcessingDots({ animate }: { animate: boolean }) {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-1.5">
      {[0, 1, 2].map((index) => (
        <motion.span
          key={index}
          className="size-1.5 rounded-full bg-current"
          initial={{ opacity: 0.25 }}
          animate={animate ? { opacity: [0.25, 1, 0.25] } : { opacity: 0.6 }}
          transition={
            animate
              ? {
                  duration: 1.05,
                  repeat: Infinity,
                  delay: index * 0.16,
                  ease: "easeInOut",
                }
              : { duration: 0.2 }
          }
        />
      ))}
    </span>
  );
}

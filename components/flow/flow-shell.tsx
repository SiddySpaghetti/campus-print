"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { toProgress, useFlow, type FlowStepId } from "@/components/flow/flow-state";
import { stepDisposition } from "@/lib/flow-access";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * Entrances are per stage rather than one generic fade, so each screen moves
 * the way its content behaves: the shop list settles into place, the upload
 * screen drops in like paper, review assembles, payment barely moves.
 */
const entrances = {
  settle: {
    initial: { opacity: 0, y: 10, scale: 0.995 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: 0.34, ease: EASE_OUT },
  },
  paper: {
    initial: { opacity: 0, y: -14, rotate: -0.6 },
    animate: { opacity: 1, y: 0, rotate: 0 },
    transition: { type: "spring", stiffness: 260, damping: 26, mass: 0.7 },
  },
  tactile: {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.26, ease: EASE_OUT },
  },
  assemble: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.2 },
  },
  focus: {
    initial: { opacity: 0, scale: 0.99 },
    animate: { opacity: 1, scale: 1 },
    transition: { duration: 0.24, ease: EASE_OUT },
  },
} as const;

export type EntranceName = keyof typeof entrances;

type FlowShellProps = {
  /** Which step this screen is, used for the access guard. */
  step: FlowStepId;
  eyebrow?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  /** Which stage entrance to use. */
  entrance?: EntranceName;
  /** Where to send people who land here without the prerequisites. */
  fallbackHref?: string;
  back?: { label?: string; href: string };
  /** `onClick` turns the continue link into an action button (Place order). */
  next?: { label?: string; href?: string; onClick?: () => void; disabled?: boolean; hint?: string };
  /** Hides the footer for screens with their own actions. */
  hideFooter?: boolean;
};

/**
 * Shared frame for every flow screen: stage-appropriate entrance, heading,
 * the back/continue footer (sticky on phones) and the guard that stops people
 * deep-linking past a step they haven't completed — or back into an order
 * they've already placed.
 */
export function FlowShell({
  step,
  eyebrow,
  title,
  description,
  children,
  entrance = "settle",
  fallbackHref = "/start-printing",
  back,
  next,
  hideFooter = false,
}: FlowShellProps) {
  const router = useRouter();
  const flow = useFlow();
  const { ready, resetFlow, orderId } = flow;

  // The policy itself lives in lib/flow-access.ts so it can be tested apart
  // from React. A placed order never drops back into upload/options/review.
  const disposition = stepDisposition(step, toProgress(flow));

  useEffect(() => {
    if (!ready) return;

    if (disposition === "start-new-order") {
      resetFlow();
    } else if (disposition === "forward-to-tracking") {
      router.replace(`/start-printing/track?order=${orderId}`);
    } else if (disposition === "send-to-start") {
      router.replace(fallbackHref);
    }
  }, [ready, disposition, router, fallbackHref, resetFlow, orderId]);

  // A step with no prerequisites (the shop picker) renders straight away, so
  // there's no loading flash on first paint. The rest wait for hydration.
  if (disposition !== "open") {
    return (
      <Container className="py-24">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {disposition === "forward-to-tracking"
            ? "That order is already placed — opening tracking…"
            : disposition === "start-new-order"
              ? "Starting a new order…"
              : ready
                ? "Taking you back to the start…"
                : "Loading your order…"}
        </p>
      </Container>
    );
  }

  const motionProps = entrances[entrance];

  return (
    <motion.div
      data-motion-static-self
      initial={motionProps.initial}
      animate={motionProps.animate}
      transition={motionProps.transition}
    >
      <Container
        className={cn("pt-8 md:pt-12", hideFooter ? "pb-16 md:pb-24" : "pb-32 md:pb-28")}
      >
        <SectionHeading as="h1" eyebrow={eyebrow} title={title} description={description} />

        <div className="mt-10 md:mt-12">{children}</div>

        {hideFooter ? null : (
          <div
            className={cn(
              // Sticky action bar on phones; inline from `md` up.
              "fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 px-5 py-3 backdrop-blur-md",
              "md:static md:mt-12 md:border-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none",
            )}
          >
            <div className="mx-auto flex w-full max-w-[1120px] items-center gap-3 md:px-0">
              {back ? (
                <Button asChild variant="outline" size="lg" className="shrink-0">
                  <Link href={back.href}>
                    <ArrowLeft aria-hidden="true" />
                    <span className="hidden sm:inline">{back.label ?? "Back"}</span>
                    <span className="sr-only sm:hidden">{back.label ?? "Back"}</span>
                  </Link>
                </Button>
              ) : null}

              {next ? (
                <ContinueButton
                  label={next.label ?? "Continue"}
                  href={next.href}
                  onClick={next.onClick}
                  disabled={next.disabled ?? false}
                />
              ) : null}
            </div>
          </div>
        )}

        {next?.hint ? (
          <p className="mt-3 hidden text-[13px] text-muted-foreground md:block" aria-live="polite">
            {next.hint}
          </p>
        ) : null}
      </Container>
    </motion.div>
  );
}

/** Springs once as it becomes available, so unlocking the step is felt. */
function ContinueButton({
  label,
  href,
  onClick,
  disabled,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  disabled: boolean;
}) {
  const reduced = useReducedMotion();

  const unlock: Variants = {
    locked: { scale: 1 },
    unlocked: reduced
      ? { scale: 1 }
      : {
          scale: [1, 1.035, 1],
          transition: { duration: 0.42, ease: EASE_OUT, times: [0, 0.45, 1] },
        },
  };

  return (
    <motion.div
      className="flex flex-1 md:flex-none"
      variants={unlock}
      initial={false}
      animate={disabled ? "locked" : "unlocked"}
    >
      {disabled || onClick || !href ? (
        <Button size="lg" disabled={disabled} onClick={onClick} className="w-full md:w-auto">
          {label}
          <ArrowRight aria-hidden="true" />
        </Button>
      ) : (
        <Button asChild size="lg" className="group w-full md:w-auto">
          <Link href={href}>
            {label}
            <ArrowRight
              aria-hidden="true"
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        </Button>
      )}
    </motion.div>
  );
}

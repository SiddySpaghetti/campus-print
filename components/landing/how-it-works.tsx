import { CreditCard, PackageCheck, Upload } from "lucide-react";

import { Reveal } from "@/components/shared/reveal";
import { Section } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";

const steps = [
  {
    icon: Upload,
    label: "Upload",
    description: "Upload your PDF or document.",
  },
  {
    icon: CreditCard,
    label: "Choose & Pay",
    description:
      "Choose a nearby print shop, select your print settings, and pay online.",
  },
  {
    icon: PackageCheck,
    label: "Pick Up",
    description:
      "Get notified when your order is ready and collect it without waiting in line.",
  },
] as const;

/** The three-step explainer directly below the hero. */
export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      aria-labelledby="how-it-works-title"
      className="scroll-mt-24"
    >
      <Reveal>
        <SectionHeading
          id="how-it-works-title"
          eyebrow="How it works"
          title="Printing shouldn't take your whole break."
          description="Send your documents ahead, pay online, and pick them up when they're ready."
        />
      </Reveal>

      <ol className="mt-12 grid gap-4 md:mt-16 md:grid-cols-3 md:gap-5">
        {steps.map((step, index) => {
          const Icon = step.icon;

          return (
            <li key={step.label} className="h-full">
              <Reveal
                delay={0.08 * (index + 1)}
                className="flex h-full flex-col gap-5 rounded-card border border-line bg-card p-6 md:p-7"
              >
                <div className="flex items-center justify-between gap-4">
                  <span
                    aria-hidden="true"
                    className="flex size-11 items-center justify-center rounded-xl border border-line bg-accent text-ink"
                  >
                    <Icon className="size-5" strokeWidth={1.75} />
                  </span>
                  <span className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Step {index + 1}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-ink">
                    {step.label}
                  </h3>
                  <p className="text-[15px] leading-relaxed text-muted-foreground text-pretty">
                    {step.description}
                  </p>
                </div>
              </Reveal>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

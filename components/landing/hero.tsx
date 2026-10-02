import Link from "next/link";
import { ArrowRight, MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Section } from "@/components/shared/section";
import { HeroHeadline } from "@/components/landing/hero-headline";
import { HeroTicket } from "@/components/landing/hero-ticket";
import { CrowdCanvas } from "@/components/ui/skiper39";
import { siteConfig } from "@/lib/site";

// Open Peeps sprite sheet (15 × 7 people) used by Skiper UI's Crowd Canvas.
const CROWD_SPRITES =
  "https://cdn.21st.dev/assets/localized/abdb8990a7bef8c2f5af3e45f0a3c969c4b0603fba8be92e81347de4ea4e1ed7.png";

export function Hero() {
  return (
    <Section
      aria-label="Introduction"
      spacing="none"
      className="relative isolate overflow-x-clip pb-20 pt-12 md:pb-28 md:pt-20"
      containerClassName="grid items-center gap-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-12"
    >
      {/* Campus crowd: transparent canvas, clipped to the hero, behind content.
          The mask keeps the headline/copy area nearly clear and lets the crowd
          build toward the bottom; on phones it stays in the bottom band. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-[0.13] [mask-image:var(--crowd-mask)] lg:[mask-composite:intersect] lg:[mask-image:var(--crowd-mask-lg)]"
        style={
          {
            "--crowd-mask": "linear-gradient(to bottom, transparent 45%, #000 85%)",
            "--crowd-mask-lg":
              "linear-gradient(to bottom, rgb(0 0 0 / 0.6) 0%, rgb(0 0 0 / 0.6) 50%, #000 85%), radial-gradient(ellipse 26% 40% at 31% 46%, rgb(0 0 0 / 0.08) 60%, #000 100%)",
          } as React.CSSProperties
        }
      >
        <CrowdCanvas
          src={CROWD_SPRITES}
          rows={15}
          cols={7}
          scale={0.5}
          density={4}
          spread={0.55}
          className="inset-0 h-full w-full"
        />
      </div>
      <div className="flex flex-col items-start">
        <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-[13px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-ink" aria-hidden="true" />
          Campus printing, without the line
        </p>

        <HeroHeadline />

        <p className="mt-6 max-w-[34rem] text-base leading-relaxed text-muted-foreground text-pretty md:text-lg">
          Upload your documents, choose your print settings, pay online, and pick
          them up when they&apos;re ready.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href={siteConfig.cta.primary.href}>
              {siteConfig.cta.primary.label}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
            <Link href={siteConfig.cta.secondary.href}>
              <MapPin aria-hidden="true" />
              {siteConfig.cta.secondary.label}
            </Link>
          </Button>
        </div>
      </div>

      <HeroTicket />
    </Section>
  );
}

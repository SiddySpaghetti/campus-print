import Link from "next/link";
import { ArrowRight, BadgeCheck, Check, Clock, MapPin, Store } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatDistance,
  formatPricePerPage,
  type PrintShop,
} from "@/lib/data/print-shops";

type PrintShopCardProps = {
  shop: PrintShop;
  /** Footer action label. Browsing says "View Shop"; the flow says "Select shop". */
  actionLabel?: string;
  /** `outline` suits a listing; `default` marks the action as primary. */
  actionVariant?: "default" | "outline";
  /** Renders the action as a link. Ignored when `onSelect` is given. */
  actionHref?: string;
  /** Turns the action into a selection button (flow use). */
  onSelect?: () => void;
  /** Draws the chosen-shop treatment. */
  selected?: boolean;
  className?: string;
};

/**
 * A print shop listing card: identity, availability, pricing and services.
 *
 * Adapted from the 21st.dev "Flight Card" pattern (@ravikatiyar162) — its
 * status pill, identity block, metric rows and price-plus-CTA footer, restyled
 * to CampusPrint's paper-and-ink system and made vertical for a 4-up grid.
 */
export function PrintShopCard({
  shop,
  actionLabel = "View Shop",
  actionVariant = "outline",
  actionHref,
  onSelect,
  selected = false,
  className,
}: PrintShopCardProps) {
  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={cn(
        // The lift and the lime marker live in the flow's ShopOption wrapper,
        // so this component stays free of Motion and usable on the landing page.
        "relative flex h-full flex-col rounded-card border bg-card p-5 transition-[border-color,box-shadow] duration-200",
        selected
          ? "border-ink shadow-[0_10px_30px_-18px_rgb(17_17_17/0.3)]"
          : "border-line",
        className,
      )}
    >
      {/* Identity + availability */}
      <div className="flex items-start justify-between gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-deep text-ink"
        >
          <Store className="size-[18px]" strokeWidth={1.75} />
        </span>
        <StatusPill isOpen={shop.isOpen} />
      </div>

      <h3 className="mt-4 flex items-center gap-1.5 font-display text-[17px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        {shop.name}
        {shop.isVerified ? (
          <>
            <BadgeCheck
              aria-hidden="true"
              className="size-[17px] shrink-0 fill-accent text-ink"
              strokeWidth={1.75}
            />
            <span className="sr-only">Verified shop</span>
          </>
        ) : null}
      </h3>

      <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <MapPin aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        {formatDistance(shop.distanceMetres)}
      </p>

      {/* Pricing + preparation time */}
      <dl className="mt-5 flex flex-col gap-2 border-t border-line pt-4 text-[13px]">
        <PriceRow label="B&W from" value={formatPricePerPage(shop.bwFromInr)} />
        <PriceRow label="Colour from" value={formatPricePerPage(shop.colourFromInr)} />
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Ready in</dt>
          <dd className="flex items-center gap-1.5 font-medium text-ink">
            <Clock aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            <span>{`~${shop.prepMinutes} min`}</span>
          </dd>
        </div>
      </dl>

      {/* Services — `mt-auto` pins the footer so cards stay aligned */}
      <div className="mt-auto pt-5">
        <ul
          aria-label={`Services at ${shop.name}`}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground"
        >
          {shop.services.map((service, index) => (
            <li key={service} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-line">
                  &bull;
                </span>
              ) : null}
              {service}
            </li>
          ))}
        </ul>

        {onSelect ? (
          <Button
            type="button"
            variant={selected ? "accent" : actionVariant}
            className="mt-4 w-full"
            onClick={onSelect}
            aria-pressed={selected}
          >
            {selected ? "Selected" : actionLabel}
            {/* Keeps each card's button distinguishable out of visual context. */}
            <span className="sr-only">{` — ${shop.name}`}</span>
            {selected ? (
              <Check aria-hidden="true" />
            ) : (
              <ArrowRight aria-hidden="true" />
            )}
          </Button>
        ) : actionHref ? (
          <Button asChild variant={actionVariant} className="mt-4 w-full">
            <Link href={actionHref}>
              {actionLabel}
              <span className="sr-only">{` — ${shop.name}`}</span>
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <Button type="button" variant={actionVariant} className="mt-4 w-full">
            {actionLabel}
            <span className="sr-only">{` — ${shop.name}`}</span>
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </article>
  );
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function StatusPill({ isOpen }: { isOpen: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em]",
        isOpen
          ? "border-signal-ready/25 bg-signal-ready/8 text-signal-ready"
          : "border-line bg-paper-deep text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          isOpen ? "bg-signal-ready" : "bg-muted-foreground",
        )}
      />
      {isOpen ? "Open" : "Closed"}
    </span>
  );
}

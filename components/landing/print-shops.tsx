import { Suspense } from "react";

import { PrintShopCard } from "@/components/print/print-shop-card";
import { Reveal } from "@/components/shared/reveal";
import { Section } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";
import type { PrintShop } from "@/lib/data/print-shops";
import { getPublicShops } from "@/lib/shops";

/* Mobile: edge-to-edge snap carousel (the negative margin cancels the
   container gutter). From `sm` up it becomes a plain grid. */
const listClass =
  "-mx-5 mt-12 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 md:mt-16 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden";
const itemClass = "w-[270px] shrink-0 snap-start sm:w-auto sm:shrink";

/**
 * Shop discovery: the real listed shops (public_shops view) a student can
 * compare before ordering. Streams in behind a skeleton so the rest of the
 * landing page isn't held up by the query.
 */
export function PrintShops() {
  return (
    <Section id="shops" aria-labelledby="shops-title" className="scroll-mt-24">
      <Reveal>
        <SectionHeading
          id="shops-title"
          eyebrow="Nearby shops"
          title="Find your print shop"
          description="Compare nearby shops, prices and preparation times before you print."
        />
      </Reveal>

      <Suspense fallback={<ShopListSkeleton />}>
        <ShopList />
      </Suspense>
    </Section>
  );
}

async function ShopList() {
  let shops: PrintShop[];
  try {
    shops = await getPublicShops();
  } catch (error) {
    console.error("Failed to load public shops", error);
    return <Notice>We couldn&rsquo;t load print shops right now. Please refresh to try again.</Notice>;
  }

  if (shops.length === 0) return <Notice>No print shops available yet.</Notice>;

  return (
    <ul className={listClass}>
      {shops.map((shop, index) => (
        <li key={shop.id} className={itemClass}>
          <Reveal delay={0.06 * (index + 1)} className="h-full">
            <PrintShopCard shop={shop} actionHref={`/start-printing?shop=${shop.id}`} />
          </Reveal>
        </li>
      ))}
    </ul>
  );
}

function ShopListSkeleton() {
  return (
    <ul className={listClass} aria-busy="true" aria-label="Loading print shops">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className={itemClass}>
          <div className="h-[340px] animate-pulse rounded-card border border-line bg-card" />
        </li>
      ))}
    </ul>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mt-12 text-[15px] text-muted-foreground md:mt-16">{children}</p>;
}

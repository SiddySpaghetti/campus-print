import { PrintShopCard } from "@/components/print/print-shop-card";
import { Reveal } from "@/components/shared/reveal";
import { Section } from "@/components/shared/section";
import { SectionHeading } from "@/components/shared/section-heading";
import { printShops } from "@/lib/data/print-shops";

/**
 * Shop discovery: the nearby print shops a student can compare before
 * ordering. Phones swipe through a snap carousel, desktop gets a 4-up grid.
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

      {/* Mobile: edge-to-edge snap carousel (the negative margin cancels the
          container gutter). From `sm` up it becomes a plain grid. */}
      <ul className="-mx-5 mt-12 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 md:mt-16 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden">
        {printShops.map((shop, index) => (
          <li
            key={shop.id}
            className="w-[270px] shrink-0 snap-start sm:w-auto sm:shrink"
          >
            <Reveal delay={0.06 * (index + 1)} className="h-full">
              <PrintShopCard shop={shop} actionHref="/start-printing" />
            </Reveal>
          </li>
        ))}
      </ul>
    </Section>
  );
}

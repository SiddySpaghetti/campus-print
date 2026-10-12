"use client";

import { useEffect } from "react";

import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow } from "@/components/flow/flow-state";
import { ShopOption } from "@/components/flow/shop-option";
import { Reveal } from "@/components/shared/reveal";
import type { FlowShop } from "@/lib/shops";

export function ShopPicker({ shops, initialShopId }: { shops: FlowShop[]; initialShopId?: string }) {
  const { shop, selectShop, ready } = useFlow();

  // Preselect the shop a landing-page "View Shop" link pointed at, once stored
  // flow state has loaded (so it isn't overwritten). Closed/unknown ids are ignored.
  useEffect(() => {
    const target = shops.find((s) => s.id === initialShopId && s.isOpen);
    if (ready && target) selectShop(target);
  }, [ready, initialShopId, shops, selectShop]);

  // Only open shops take orders (create_order_verified enforces it too).
  const selected = shop && shops.some((s) => s.id === shop.id && s.isOpen) ? shop : null;

  return (
    <FlowShell
      step="shop"
      eyebrow="Step 1 of 5"
      title="Choose a print shop"
      description="Compare nearby shops, prices and preparation times, then pick where you want to print."
      entrance="settle"
      back={{ label: "Back to home", href: "/" }}
      next={{
        href: "/start-printing/upload",
        disabled: !selected,
        hint: selected
          ? `${selected.name} selected — continue to upload your document.`
          : "Select an open shop to continue.",
      }}
    >
      {shops.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">No print shops are listed yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {shops.map((item, index) => (
            <li key={item.id} className="h-full">
              <Reveal delay={0.06 * (index + 1)} className="h-full">
                <ShopOption
                  shop={item}
                  selected={item.id === selected?.id}
                  anySelected={Boolean(selected)}
                  onSelect={item.isOpen ? () => selectShop(item) : undefined}
                />
              </Reveal>
            </li>
          ))}
        </ul>
      )}
    </FlowShell>
  );
}

"use client";

import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow } from "@/components/flow/flow-state";
import { ShopOption } from "@/components/flow/shop-option";
import { Reveal } from "@/components/shared/reveal";
import { printShops } from "@/lib/data/print-shops";

export default function ChooseShopPage() {
  const { shopId, selectShop, shop } = useFlow();

  return (
    <FlowShell
      step="shop"
      eyebrow="Step 1 of 6"
      title="Choose a print shop"
      description="Compare nearby shops, prices and preparation times, then pick where you want to print."
      entrance="settle"
      back={{ label: "Back to home", href: "/" }}
      next={{
        href: "/start-printing/upload",
        disabled: !shopId,
        hint: shop
          ? `${shop.name} selected — continue to upload your document.`
          : "Select a shop to continue.",
      }}
    >
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {printShops.map((item, index) => (
          <li key={item.id} className="h-full">
            <Reveal delay={0.06 * (index + 1)} className="h-full">
              <ShopOption
                shop={item}
                selected={item.id === shopId}
                anySelected={Boolean(shopId)}
                onSelect={() => selectShop(item.id)}
              />
            </Reveal>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-[13px] text-muted-foreground">
        Sample shops and prices, shown to demonstrate the flow.
      </p>
    </FlowShell>
  );
}

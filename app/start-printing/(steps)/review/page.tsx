"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "motion/react";

import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow } from "@/components/flow/flow-state";
import { OrderSummary } from "@/components/flow/order-summary";
import { postJson } from "@/lib/api-client";

export default function ReviewPage() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const { shop, file, options, price, setOrderId } = useFlow();
  // The CTA arms once the summary has finished assembling, so people see the
  // whole order before they can move on. Reduced motion skips the wait.
  const [assembled, setAssembled] = useState(reduced);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Safety net: the assembly takes ~0.7s, so arm the CTA regardless by 1.5s.
  // A missed animation callback must never leave a permanently dead button.
  useEffect(() => {
    const timer = setTimeout(() => setAssembled(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  // The server picks the payment method: ONLINE shops are paid on the track
  // page (Pay now), the rest are PAY_AT_COUNTER and paid in person at pickup.
  const placeOrder = async () => {
    if (!shop || !file || placing) return;
    setPlacing(true);
    setError(null);
    try {
      // Only choices and the upload path go up. Price and page count are
      // derived on the server; the API rejects any extra field.
      const { order } = await postJson<{ order: { id: string } }>("/api/orders", {
        shopId: shop.id,
        colour: options.colour,
        paper: options.paper,
        sides: options.sides,
        copies: options.copies,
        note: null,
        files: [{ path: file.path, name: file.name }],
      });
      setOrderId(order.id);
      router.replace(`/start-printing/track?order=${order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to create order.");
      setPlacing(false);
    }
  };

  return (
    <FlowShell
      step="review"
      eyebrow="Step 4 of 5"
      title="Review your order"
      description="Check everything over before you place it. You can still change any part of it."
      entrance="assemble"
      back={{ href: "/start-printing/options" }}
      next={{
        label: placing ? "Placing order…" : "Place order",
        onClick: placeOrder,
        disabled: !assembled || placing || !price,
        hint: "Nothing is charged now. How you pay is shown once your order is placed. The final price is confirmed by the server.",
      }}
    >
      <div className="mx-auto max-w-xl">
        <OrderSummary
          assemble={!reduced}
          onAssembled={() => setAssembled(true)}
          edits={{
            shop: "/start-printing",
            document: "/start-printing/upload",
            options: "/start-printing/options",
          }}
        />
        {error ? (
          <p role="alert" className="mt-4 text-[13px] font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </FlowShell>
  );
}

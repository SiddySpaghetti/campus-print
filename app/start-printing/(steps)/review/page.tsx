"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "motion/react";

import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow } from "@/components/flow/flow-state";
import { OrderSummary } from "@/components/flow/order-summary";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/api-client";

type Quote = { unit: "sheet" | "page"; ratePaise: number; totalPages: number; sheets: number; totalPaise: number };

export default function ReviewPage() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const { shop, files, options, price, setOrderId } = useFlow();
  // The CTA arms once the summary has finished assembling, so people see the
  // whole order before they can move on. Reduced motion skips the wait.
  const [assembled, setAssembled] = useState(reduced);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ key: string; value: Quote } | null>(null);
  const [quoteFailure, setQuoteFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Safety net: the assembly takes ~0.7s, so arm the CTA regardless by 1.5s.
  // A missed animation callback must never leave a permanently dead button.
  useEffect(() => {
    const timer = setTimeout(() => setAssembled(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  // Only choices and upload paths go up. Price and page counts are derived on
  // the server; the API rejects any extra field.
  const body = useMemo(
    () =>
      shop && files.length > 0
        ? {
            shopId: shop.id,
            colour: options.colour,
            paper: options.paper,
            sides: options.sides,
            copies: options.copies,
            note: null,
            files: files.map((f) => ({ path: f.path, name: f.name })),
          }
        : null,
    [shop, files, options],
  );
  const key = `${attempt}:${JSON.stringify(body)}`;

  // The final price is the server's, from the stored bytes, before anything is placed.
  useEffect(() => {
    if (!body) return;
    let live = true;
    postJson<{ quote: Quote }>("/api/orders/quote", body)
      .then((response) => {
        if (live) setQuote({ key, value: response.quote });
      })
      .catch((e: unknown) => {
        if (live) setQuoteFailure({ key, message: e instanceof Error ? e.message : "The price couldn't be confirmed." });
      });
    return () => {
      live = false;
    };
  }, [body, key]);

  const currentQuote = quote?.key === key ? quote.value : null;
  const quoteError = quoteFailure?.key === key ? quoteFailure.message : null;

  // The server picks the payment method: ONLINE shops are paid on the track
  // page (Pay now), the rest are PAY_AT_COUNTER and paid in person at pickup.
  const placeOrder = async () => {
    if (!body || !currentQuote || placing) return;
    setPlacing(true);
    setError(null);
    try {
      // The quote is what the student agreed to: if it moved, the server refuses.
      const { order } = await postJson<{ order: { id: string } }>("/api/orders", {
        ...body,
        quotedTotalPaise: currentQuote.totalPaise,
      });
      setOrderId(order.id);
      router.replace(`/start-printing/track?order=${order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to create order.");
      setPlacing(false);
      setAttempt((n) => n + 1); // the price may have changed: fetch it again
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
        disabled: !assembled || placing || !price || !currentQuote,
        hint: "Nothing is charged now. How you pay is shown once your order is placed.",
      }}
    >
      <div className="mx-auto max-w-xl">
        <OrderSummary
          assemble={!reduced}
          onAssembled={() => setAssembled(true)}
          quote={currentQuote}
          edits={{
            shop: "/start-printing",
            document: "/start-printing/upload",
            options: "/start-printing/options",
          }}
        />
        {!currentQuote && !quoteError ? (
          <p aria-live="polite" className="mt-4 text-[13px] text-muted-foreground">
            Confirming the final price…
          </p>
        ) : null}
        {quoteError ? (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-[13px] font-medium text-destructive">
            <span>{quoteError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-[13px] font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </FlowShell>
  );
}

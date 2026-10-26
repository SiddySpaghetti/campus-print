"use client";

import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow } from "@/components/flow/flow-state";
import { OrderSummary } from "@/components/flow/order-summary";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { QuantityField } from "@/components/ui/quantity-field";
import {
  colourOptions,
  MAX_COPIES,
  MIN_COPIES,
  paperOptions,
  sidesOptions,
  type ColourMode,
  type PaperSize,
  type SideMode,
} from "@/lib/pricing";

export default function OptionsPage() {
  const { options, setOptions, setCopies, price } = useFlow();

  return (
    <FlowShell
      step="options"
      eyebrow="Step 3 of 5"
      title="How should we print it?"
      description="Prices update as you change the settings."
      entrance="tactile"
      back={{ href: "/start-printing/upload" }}
      next={{
        href: "/start-printing/review",
        disabled: !price,
        hint: price ? undefined : "This shop doesn't offer that colour and paper combination.",
      }}
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-10">
        <div className="flex flex-col divide-y divide-line rounded-card border border-line bg-card">
          <Row label="Colour" hint="Colour costs more per sheet.">
            <SegmentedControl
              label="Colour"
              tone="accent"
              options={colourOptions}
              value={options.colour}
              onValueChange={(value) => setOptions({ colour: value as ColourMode })}
            />
          </Row>

          <Row label="Paper" hint="A3 is priced per sheet by the shop.">
            <SegmentedControl
              label="Paper size"
              options={paperOptions}
              value={options.paper}
              onValueChange={(value) => setOptions({ paper: value as PaperSize })}
            />
          </Row>

          <Row label="Sides" hint="Double-sided halves the sheets. Shops that charge per page price by pages, not sheets.">
            <SegmentedControl
              label="Sides"
              options={sidesOptions}
              value={options.sides}
              onValueChange={(value) => setOptions({ sides: value as SideMode })}
            />
          </Row>

          <Row label="Copies">
            <QuantityField
              label="Copies"
              value={options.copies}
              onValueChange={setCopies}
              min={MIN_COPIES}
              max={MAX_COPIES}
            />
          </Row>
        </div>

        <OrderSummary className="lg:sticky lg:top-6 lg:self-start" />
      </div>
    </FlowShell>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6 md:p-6">
      <div>
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </h2>
        {hint ? (
          <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * MOCK DATA — illustrative order used by the hero ticket mockup.
 * Not a real order, shop, or price quote.
 */
export type OrderStatus = "received" | "printing" | "ready";

export type SampleOrder = {
  token: string;
  pages: number;
  colour: "B&W" | "Colour";
  sides: "Single-sided" | "Double-sided";
  totalInr: number;
  status: OrderStatus;
  /** 0–1, how far the current print job has progressed. */
  progress: number;
};

export const sampleOrder: SampleOrder = {
  token: "A-042",
  pages: 12,
  colour: "B&W",
  sides: "Double-sided",
  totalInr: 36,
  status: "printing",
  progress: 0.58,
};

export const orderSteps: { id: OrderStatus; label: string }[] = [
  { id: "received", label: "Received" },
  { id: "printing", label: "Printing" },
  { id: "ready", label: "Ready for pickup" },
];

export function formatInr(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

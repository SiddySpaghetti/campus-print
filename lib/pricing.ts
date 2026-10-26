/**
 * Print option types, labels and the price ESTIMATE shown in the student flow.
 *
 * Shops charge per *sheet* (double-sided puts two pages on one sheet), from
 * their shop_pricing rows — unless the shop has per-page tiers for that
 * colour/paper (shop_page_price_tiers, e.g. K2's A4 B&W), which price by
 * billable pages (pages x copies) instead. The authoritative total is computed
 * by the database (create_order_verified) from server-counted pages; this
 * mirrors its maths so the estimate matches for readable files.
 */
import type { FlowShop } from "@/lib/shops";

export type ColourMode = "bw" | "colour";
export type PaperSize = "a4" | "a3";
export type SideMode = "single" | "double";

export type PrintOptions = {
  colour: ColourMode;
  paper: PaperSize;
  sides: SideMode;
  copies: number;
};

export const defaultPrintOptions: PrintOptions = {
  colour: "bw",
  paper: "a4",
  sides: "single",
  copies: 1,
};

export const MIN_COPIES = 1;
export const MAX_COPIES = 20;

// `as const satisfies` keeps the literal types, so these labels can be handed
// straight to components with narrower unions (e.g. the order ticket).
export const colourLabels = {
  bw: "B&W",
  colour: "Colour",
} as const satisfies Record<ColourMode, string>;

export const paperLabels = {
  a4: "A4",
  a3: "A3",
} as const satisfies Record<PaperSize, string>;

export const sidesLabels = {
  single: "Single-sided",
  double: "Double-sided",
} as const satisfies Record<SideMode, string>;

export const colourOptions = [
  { value: "bw", label: colourLabels.bw },
  { value: "colour", label: colourLabels.colour },
];

export const paperOptions = [
  { value: "a4", label: paperLabels.a4 },
  { value: "a3", label: paperLabels.a3 },
];

export const sidesOptions = [
  { value: "single", label: "Single" },
  { value: "double", label: "Double" },
];

/** A per-page rate that applies from `minPages` billable pages (pages x copies). */
export type PageTier = { minPages: number; pricePaise: number };

type SheetPrice = {
  /** Rupees per printed sheet, after colour and paper size. */
  ratePerSheet: number;
  perPage?: undefined;
};
type PagePrice = {
  /** A per-page tier applied (e.g. K2's A4 B&W): rupees per page and billable pages. */
  perPage: { rate: number; pages: number };
  ratePerSheet?: undefined;
};
export type PriceBreakdown = (SheetPrice | PagePrice) & {
  /** Sheets one copy needs. */
  sheetsPerCopy: number;
  /** Sheets for the whole order. */
  sheets: number;
  total: number;
};

/**
 * The rate (paise) for this many billable pages: the tier with the highest
 * minPages not above it, or null. Mirrors create_order_verified.
 */
export function pageTierRate(tiers: readonly PageTier[] | undefined, billablePages: number): number | null {
  let best: PageTier | null = null;
  for (const t of tiers ?? []) {
    if (t.minPages <= billablePages && (!best || t.minPages > best.minPages)) best = t;
  }
  return best ? best.pricePaise : null;
}

/** Null when the shop doesn't offer this colour/paper combination. */
export function calculatePrice({
  shop,
  options,
  pageCount,
}: {
  shop: FlowShop;
  options: PrintOptions;
  pageCount: number;
}): PriceBreakdown | null {
  const key = `${options.colour}_${options.paper}` as const;
  const ratePaise = shop.ratesPaise[key];
  if (ratePaise === undefined) return null;
  const copies = Math.max(MIN_COPIES, options.copies);
  const sheetsPerCopy =
    options.sides === "double" ? Math.ceil(pageCount / 2) : pageCount;
  const sheets = sheetsPerCopy * copies;

  // Integer paise first, so there's no float drift.
  const pages = pageCount * copies;
  const tierPaise = pageTierRate(shop.pageTiersPaise?.[key], pages);
  if (tierPaise !== null) {
    return { perPage: { rate: tierPaise / 100, pages }, sheetsPerCopy, sheets, total: (tierPaise * pages) / 100 };
  }
  return { ratePerSheet: ratePaise / 100, sheetsPerCopy, sheets, total: (ratePaise * sheets) / 100 };
}

/** Rupees with paise only when the amount actually has them. */
export function formatRupees(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short label for a file's type, e.g. "PDF". */
export function fileKindLabel(file: { name: string; type: string }) {
  const extension = file.name.split(".").pop()?.toUpperCase();
  if (extension === "JPEG") return "JPG";
  if (extension) return extension;
  return file.type.split("/").pop()?.toUpperCase() ?? "FILE";
}

export const ACCEPTED_FILE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

export const ACCEPTED_FILE_HINT = "PDF, PNG or JPG";

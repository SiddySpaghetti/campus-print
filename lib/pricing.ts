/**
 * MOCK PRICING — the single source of truth for print option types, labels and
 * the price calculation used across the student flow.
 *
 * Shops are charged per *sheet*, not per page: printing double-sided puts two
 * pages on one sheet, so it is cheaper. A3 costs double an A4 sheet. Swap the
 * constants (or the whole function) for real shop rates later.
 */
import type { PrintShop } from "@/lib/data/print-shops";

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

/**
 * Fallback page count, used only for a PDF whose page tree can't be read (and
 * before any document is chosen). Images and readable PDFs report their real
 * count — see `resolvePageCount` in lib/page-count.ts.
 */
export const DEMO_PAGE_COUNT = 12;

export const MIN_COPIES = 1;
export const MAX_COPIES = 20;

/** An A3 sheet costs this much more than A4. */
const A3_MULTIPLIER = 2;

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

export type PriceBreakdown = {
  /** Rupees per printed sheet, after colour and paper size. */
  ratePerSheet: number;
  /** Sheets one copy needs. */
  sheetsPerCopy: number;
  /** Sheets for the whole order. */
  sheets: number;
  total: number;
};

export function calculatePrice({
  shop,
  options,
  pageCount,
}: {
  shop: PrintShop;
  options: PrintOptions;
  pageCount: number;
}): PriceBreakdown {
  const base = options.colour === "colour" ? shop.colourFromInr : shop.bwFromInr;
  const ratePerSheet = base * (options.paper === "a3" ? A3_MULTIPLIER : 1);
  const sheetsPerCopy =
    options.sides === "double" ? Math.ceil(pageCount / 2) : pageCount;
  const sheets = sheetsPerCopy * Math.max(MIN_COPIES, options.copies);

  return {
    ratePerSheet,
    sheetsPerCopy,
    sheets,
    // Guard against float drift from the 1.50 rates.
    total: Math.round(ratePerSheet * sheets * 100) / 100,
  };
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

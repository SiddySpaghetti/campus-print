/**
 * Print option types, labels and the price ESTIMATE shown in the student flow.
 *
 * Shops charge per *sheet*: double-sided puts two pages on one sheet. Rates
 * come from the shop's real shop_pricing rows. The authoritative total is
 * computed by the database (create_order_verified) from server-counted pages;
 * this mirrors its sheet maths so the estimate matches for readable files.
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

export type PriceBreakdown = {
  /** Rupees per printed sheet, after colour and paper size. */
  ratePerSheet: number;
  /** Sheets one copy needs. */
  sheetsPerCopy: number;
  /** Sheets for the whole order. */
  sheets: number;
  total: number;
};

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
  const ratePaise = shop.ratesPaise[`${options.colour}_${options.paper}`];
  if (ratePaise === undefined) return null;
  const sheetsPerCopy =
    options.sides === "double" ? Math.ceil(pageCount / 2) : pageCount;
  const sheets = sheetsPerCopy * Math.max(MIN_COPIES, options.copies);

  return {
    ratePerSheet: ratePaise / 100,
    sheetsPerCopy,
    sheets,
    // Integer paise first, so there's no float drift.
    total: (ratePaise * sheets) / 100,
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

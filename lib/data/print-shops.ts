/**
 * MOCK DATA — illustrative print shops used by the "Find your print shop"
 * section. Not real shops, prices, or availability.
 *
 * Shaped to match a future `print_shops` table: identifiers and raw numbers
 * (metres, rupees, minutes) are stored, and all formatting happens in the UI,
 * so swapping this module for a Supabase query needs no component changes.
 */
export type PrintShop = {
  id: string;
  name: string;
  isVerified: boolean;
  isOpen: boolean;
  /** Walking distance from campus, in metres. Null when the shop hasn't set it. */
  distanceMetres: number | null;
  /** Cheapest black-and-white price per page, in rupees. Null if not offered. */
  bwFromInr: number | null;
  /** Cheapest colour price per page, in rupees. Null if not offered. */
  colourFromInr: number | null;
  /** Typical time from order to pickup, in minutes. */
  prepMinutes: number;
  services: string[];
};

export const printShops: PrintShop[] = [
  {
    id: "abc-xerox",
    name: "ABC Xerox",
    isVerified: true,
    isOpen: true,
    distanceMetres: 150,
    bwFromInr: 2,
    colourFromInr: 10,
    prepMinutes: 10,
    services: ["Printing", "Photocopy", "Scanning"],
  },
  {
    id: "campus-print-hub",
    name: "Campus Print Hub",
    isVerified: true,
    isOpen: true,
    distanceMetres: 300,
    bwFromInr: 1.5,
    colourFromInr: 8,
    prepMinutes: 15,
    services: ["Printing", "Photocopy", "Scanning", "Lamination"],
  },
  {
    id: "student-copy-center",
    name: "Student Copy Center",
    isVerified: true,
    isOpen: true,
    distanceMetres: 500,
    bwFromInr: 2,
    colourFromInr: 9,
    prepMinutes: 12,
    services: ["Printing", "Photocopy", "Binding"],
  },
  {
    id: "quickprint",
    name: "QuickPrint",
    isVerified: true,
    isOpen: false,
    distanceMetres: 650,
    bwFromInr: 1.5,
    colourFromInr: 8,
    prepMinutes: 20,
    services: ["Printing", "Photocopy", "Scanning"],
  },
];

/**
 * Per-page prices keep their paise (₹1.50), unlike order totals — so this is
 * separate from `formatInr` in `sample-order.ts`, which rounds to whole rupees.
 */
export function formatPricePerPage(amount: number | null) {
  if (amount === null) return "—";
  const hasPaise = !Number.isInteger(amount);

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDistance(metres: number) {
  return metres < 1000 ? `${metres}m away` : `${(metres / 1000).toFixed(1)}km away`;
}

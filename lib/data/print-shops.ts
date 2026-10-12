/**
 * Display shape of a listed print shop, filled from the public_shops view by
 * `lib/shops.ts`. Raw numbers (metres, rupees, minutes) are stored and all
 * formatting happens in the UI.
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

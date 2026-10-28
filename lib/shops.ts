import type { PriceRange, PrintShop } from "@/lib/data/print-shops";
import type { ColourMode, PageTier, PaperSize } from "@/lib/pricing";
import { createClient } from "@/utils/supabase/server";

export type RateKey = `${ColourMode}_${PaperSize}`;

/**
 * A listed shop plus its print rates, for showing estimates only: per-sheet
 * rates, and per-page tiers where the shop has them (e.g. K2's A4 B&W).
 */
export type FlowShop = PrintShop & {
  ratesPaise: Partial<Record<RateKey, number>>;
  pageTiersPaise?: Partial<Record<RateKey, PageTier[]>>;
};

type PricingRow = { shop_id: string; colour_mode: string; paper_size: string; price_paise: number };
type TierRow = PricingRow & { min_pages: number };

/** PostgREST / Postgres "no such table": shop_page_price_tiers before its migration is applied. */
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

/** Pure: attach each shop's rates and tiers. */
export function toFlowShops(shops: PrintShop[], pricing: PricingRow[], tiers: TierRow[]): FlowShop[] {
  return shops.map((s) => {
    const ratesPaise: FlowShop["ratesPaise"] = {};
    for (const p of pricing) {
      if (p.shop_id === s.id) ratesPaise[`${p.colour_mode}_${p.paper_size}` as RateKey] = p.price_paise;
    }
    const pageTiersPaise: NonNullable<FlowShop["pageTiersPaise"]> = {};
    for (const t of tiers) {
      if (t.shop_id !== s.id) continue;
      const key = `${t.colour_mode}_${t.paper_size}` as RateKey;
      (pageTiersPaise[key] ??= []).push({ minPages: t.min_pages, pricePaise: t.price_paise });
    }
    return { ...s, ratesPaise, pageTiersPaise };
  });
}

/**
 * Lowest-highest per-page rate (rupees) of one colour's tiers from
 * public_shops.page_tiers; null without tiers or before that column exists.
 */
export function perPageRange(tiers: unknown, colour: ColourMode): PriceRange | null {
  const rates = (Array.isArray(tiers) ? (tiers as { colour_mode?: unknown; price_paise?: unknown }[]) : [])
    .filter((t) => t.colour_mode === colour && Number.isInteger(t.price_paise))
    .map((t) => (t.price_paise as number) / 100);
  return rates.length ? { min: Math.min(...rates), max: Math.max(...rates) } : null;
}

const serviceLabels: Record<string, string> = {
  print: "Printing",
  photocopy: "Photocopy",
  scanning: "Scanning",
  binding: "Binding",
  lamination: "Lamination",
};

/**
 * Verified, non-deleted shops that take new orders (public_shops.listed), from
 * the public_shops view, in its sort order. The view is the only shop source
 * signed-out visitors may read (anon has no table grants), so the landing page
 * uses this alone. Unlisted shops stay in the view so past orders keep their
 * shop name; create_order_verified refuses them server-side.
 */
export async function getPublicShops(): Promise<PrintShop[]> {
  const supabase = await createClient();
  // `*` rather than a column list: `listed` only exists once its migration is
  // applied, and a missing column must not take the shop list down.
  const { data, error } = await supabase.from("public_shops").select("*");
  if (error) throw error;

  return data.filter((s) => s.listed !== false).map((s) => ({
    id: s.id,
    name: s.name,
    isVerified: true, // the view only lists verified shops
    isOpen: s.is_open,
    distanceMetres: s.distance_metres,
    bwFromInr: s.bw_from_paise == null ? null : s.bw_from_paise / 100,
    colourFromInr: s.colour_from_paise == null ? null : s.colour_from_paise / 100,
    bwPerPageInr: perPageRange(s.page_tiers, "bw"),
    colourPerPageInr: perPageRange(s.page_tiers, "colour"),
    prepMinutes: s.prep_minutes,
    services: (s.services as string[]).map((x) => serviceLabels[x] ?? x),
  }));
}

/**
 * Listed shops plus print rates from shop_pricing (RLS: active rates of listed
 * shops, signed-in users only). Prices here are display estimates;
 * create_order_verified re-prices from the database when the order is placed.
 */
export async function getListedShops(): Promise<FlowShop[]> {
  const supabase = await createClient();
  const [shops, pricing, tiers] = await Promise.all([
    getPublicShops(),
    supabase
      .from("shop_pricing")
      .select("shop_id, colour_mode, paper_size, price_paise")
      .eq("service", "print"),
    supabase.from("shop_page_price_tiers").select("shop_id, colour_mode, paper_size, min_pages, price_paise"),
  ]);
  if (pricing.error) throw pricing.error;
  // Before the tiers migration the table doesn't exist and nobody is priced by
  // tier (the database neither): estimate per sheet. Any other error is real.
  if (tiers.error && !MISSING_TABLE.has(tiers.error.code)) throw tiers.error;

  return toFlowShops(shops, pricing.data, tiers.error ? [] : tiers.data);
}

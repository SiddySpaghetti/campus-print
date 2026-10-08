import type { PrintShop } from "@/lib/data/print-shops";
import type { ColourMode, PaperSize } from "@/lib/pricing";
import { createClient } from "@/utils/supabase/server";

export type RateKey = `${ColourMode}_${PaperSize}`;

/** A listed shop plus its per-sheet print rates, for showing estimates only. */
export type FlowShop = PrintShop & { ratesPaise: Partial<Record<RateKey, number>> };

const serviceLabels: Record<string, string> = {
  print: "Printing",
  photocopy: "Photocopy",
  scanning: "Scanning",
  binding: "Binding",
  lamination: "Lamination",
};

/**
 * Verified shops from the public_shops view, plus print rates from
 * shop_pricing (RLS: active rates of listed shops, signed-in users only).
 * Prices here are display estimates; create_order_verified re-prices from the
 * database when the order is placed.
 */
export async function getListedShops(): Promise<FlowShop[]> {
  const supabase = await createClient();
  const [shops, pricing] = await Promise.all([
    supabase
      .from("public_shops")
      .select("id, name, distance_metres, is_open, prep_minutes, bw_from_paise, colour_from_paise, services"),
    supabase
      .from("shop_pricing")
      .select("shop_id, colour_mode, paper_size, price_paise")
      .eq("service", "print"),
  ]);
  if (shops.error) throw shops.error;
  if (pricing.error) throw pricing.error;

  return shops.data.map((s) => {
    const ratesPaise: FlowShop["ratesPaise"] = {};
    for (const p of pricing.data) {
      if (p.shop_id === s.id) ratesPaise[`${p.colour_mode}_${p.paper_size}` as RateKey] = p.price_paise;
    }
    return {
      id: s.id,
      name: s.name,
      isVerified: true, // the view only lists verified shops
      isOpen: s.is_open,
      distanceMetres: s.distance_metres,
      bwFromInr: s.bw_from_paise == null ? null : s.bw_from_paise / 100,
      colourFromInr: s.colour_from_paise == null ? null : s.colour_from_paise / 100,
      prepMinutes: s.prep_minutes,
      services: (s.services as string[]).map((x) => serviceLabels[x] ?? x),
      ratesPaise,
    };
  });
}

import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, readJson, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseShopOpen } from "@/lib/server/validate";

/**
 * Opens or closes the signed-in shopkeeper's own shop to new orders. Runs AS
 * the shopkeeper: RLS (shops_update_own_shop) limits it to their shop and
 * shops_guard lets them change only is_open and prep_minutes. Orders already
 * placed keep going either way.
 */
export function POST(request: Request) {
  return handle("api/shop/open", async () => {
    const { supabase, user, shopId } = await requireRole("shopkeeper");
    if (!shopId) return errorResponse(SAFE.forbidden);

    const limited = await rateLimit(`shop_open:${user.id}`, 30, 600);
    if (limited) return limited;

    const { open } = parseShopOpen(await readJson(request, 200));
    const { data, error } = await supabase
      .from("shops")
      .update({ is_open: open })
      .eq("id", shopId)
      .select("is_open")
      .maybeSingle();
    if (error) {
      logServerError("api/shop/open", error);
      return errorResponse(mapDbError(error, SAFE.internal));
    }
    if (!data) return errorResponse(SAFE.forbidden);
    return Response.json({ isOpen: data.is_open });
  });
}

import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, readJson, SAFE } from "@/lib/server/errors";
import { inspectOrderFiles, quoteOrder, type OrderQuote } from "@/lib/server/order-files";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseCreateOrder } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * The server-calculated price, shown before the student places an order. Same
 * body as POST /api/orders; nothing is created. The server re-reads the stored
 * bytes (nothing the browser says about pages is believed) and public.quote_order
 * prices them with the same SQL create_order_verified uses.
 */
export function POST(request: Request) {
  return handle("api/orders/quote", async () => {
    const { user } = await requireRole("student");

    const limited = await rateLimit(`order_quote:${user.id}`, 60, 3600);
    if (limited) return limited;

    const input = parseCreateOrder(await readJson(request), user.id);
    const admin = createAdminClient();
    const files = await inspectOrderFiles(admin, input.files);

    const { data, error } = await quoteOrder(admin, input, files);
    if (error || !data) {
      logServerError("api/orders/quote", error);
      return errorResponse(mapDbError(error ?? {}, SAFE.quoteFailed));
    }
    return Response.json({ quote: data as OrderQuote });
  });
}

import { canPrint } from "@/lib/orders";
import type { OrderStatus } from "@/components/flow/order-tracker";
import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUuidParam } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

type PrintRow = {
  id: string;
  shop_id: string;
  status: OrderStatus;
  payment_method: string;
  payment_status: string;
  accept_first: boolean;
  order_files: {
    id: string;
    storage_path: string;
    original_name: string;
    mime_type: string;
    page_count: number;
    sort_order: number;
    file_deleted_at: string | null;
  }[];
};

/** Long enough to start fetching a few files; the browser never sees them again. */
const URL_SECONDS = 120;

/**
 * The Print Document action: hands the order's files to the shopkeeper's browser
 * so it can build the PDF and open the native print dialog. This records a print
 * REQUEST (print_requested_at) and nothing else: the order stays as it was, the
 * student is not told anything, and nobody may treat it as printing.
 *
 * Reads run AS the shopkeeper, so RLS and the Storage policy decide: another
 * shop's order finds nothing, and an unpaid online order's bytes can't be signed
 * even if every check here were wrong. Order: refuse unpaid/closed orders, refuse
 * if any file is gone (a partial print must not look complete), sign every URL,
 * and only then record the request. A failure at any step changes nothing.
 */
export function POST(_request: Request, ctx: RouteContext<"/api/shop/orders/[id]/print">) {
  return handle("api/shop/orders/print", async () => {
    const { supabase, user, shopId } = await requireRole("shopkeeper");
    const orderId = parseUuidParam((await ctx.params).id);

    const limited = await rateLimit(`shop_print:${user.id}`, 120, 600);
    if (limited) return limited;

    const { data: order } = await supabase
      .from("orders")
      .select(
        "id, shop_id, status, payment_method, payment_status, accept_first, order_files(id, storage_path, original_name, mime_type, page_count, sort_order, file_deleted_at)",
      )
      .eq("id", orderId)
      .maybeSingle<PrintRow>();
    if (!order || order.shop_id !== shopId) return errorResponse(SAFE.notFound);
    if (order.payment_method !== "PAY_AT_COUNTER" && order.payment_status !== "PAID") return errorResponse(SAFE.unpaid);
    if (!canPrint(order)) return errorResponse(SAFE.notPrintable);

    const files = [...order.order_files].sort((a, b) => a.sort_order - b.sort_order);
    if (files.length === 0 || files.some((f) => f.file_deleted_at)) return errorResponse(SAFE.filesMissing);

    const signed = [];
    for (const f of files) {
      const { data } = await supabase.storage.from("print-files").createSignedUrl(f.storage_path, URL_SECONDS);
      if (!data?.signedUrl) return errorResponse(SAFE.downloadFailed);
      signed.push({ id: f.id, name: f.original_name, mime: f.mime_type, pageCount: f.page_count, url: data.signedUrl });
    }

    const { data: previous, error } = await createAdminClient().rpc("request_print", {
      p_order_id: order.id,
      p_shop_id: shopId,
    });
    if (error) {
      logServerError("api/shop/orders/print", error);
      return errorResponse(error.code === "P0001" ? SAFE.notPrintable : SAFE.statusFailed);
    }
    return Response.json({ files: signed, previouslyRequestedAt: (previous as string | null) ?? null });
  });
}

import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUuidParam } from "@/lib/server/validate";

type FileRow = {
  storage_path: string;
  original_name: string;
  file_deleted_at: string | null;
  order: { id: string; shop_id: string; status: string; payment_method: string; payment_status: string } | null;
};

/** A closed order's files are not for printing. */
const DOWNLOADABLE = ["PENDING", "ACCEPTED", "PRINTING", "READY"];

/**
 * Opens one original file of a paid (or pay-at-counter) order: returns a 60-second
 * signed URL as JSON. It changes nothing: only the shopkeeper's confirmation after
 * a print request starts printing (POST /api/shop/orders/[id]/printing).
 *
 * Lookups run AS the shopkeeper, so RLS (order_files_select_shop) and the Storage
 * policy (print_files_select_shop) decide: another shop's file id simply finds
 * nothing, and an unpaid online order's bytes can't be signed. Shops see those
 * orders' file names, never their contents. The profile's shop id is checked again
 * on top, and closed or unpaid orders are refused here too.
 */
export function POST(_request: Request, ctx: RouteContext<"/api/shop/files/[id]">) {
  return handle("api/shop/files", async () => {
    const { supabase, user, shopId } = await requireRole("shopkeeper");
    const fileId = parseUuidParam((await ctx.params).id);

    const limited = await rateLimit(`shop_file:${user.id}`, 200, 600);
    if (limited) return limited;

    const { data: file } = await supabase
      .from("order_files")
      .select("storage_path, original_name, file_deleted_at, order:orders(id, shop_id, status, payment_method, payment_status)")
      .eq("id", fileId)
      .maybeSingle<FileRow>();
    const order = file?.order;
    if (!file || file.file_deleted_at || !order || order.shop_id !== shopId) return errorResponse(SAFE.notFound);
    if (!DOWNLOADABLE.includes(order.status)) return errorResponse(SAFE.notPrintable);
    if (order.payment_method !== "PAY_AT_COUNTER" && order.payment_status !== "PAID") {
      return errorResponse(SAFE.unpaid);
    }

    const { data: signed } = await supabase.storage
      .from("print-files")
      .createSignedUrl(file.storage_path, 60, { download: file.original_name });
    if (!signed?.signedUrl) return errorResponse(SAFE.downloadFailed);

    return Response.json({ url: signed.signedUrl });
  });
}

import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUuidParam } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

type FileRow = {
  storage_path: string;
  original_name: string;
  file_deleted_at: string | null;
  order: { id: string; shop_id: string; status: string; payment_method: string; payment_status: string } | null;
};

/** A closed order's files are not for printing. */
const DOWNLOADABLE = ["PENDING", "ACCEPTED", "PRINTING", "READY"];

/**
 * Statuses a download moves to PRINTING. Paid online orders skip Accept; counter
 * orders must be accepted first (a PENDING counter download is only a look).
 * Mirrors orders_lifecycle, which stays the authority.
 */
function printFrom(paymentMethod: string): string[] {
  return paymentMethod === "ONLINE" ? ["PENDING", "ACCEPTED"] : ["ACCEPTED"];
}

/**
 * Download a file of one of the shopkeeper's orders: returns a 60-second signed
 * URL as JSON. A POST (not a link) because the download is what starts
 * printing, and the dashboard shows a failure in place.
 *
 * Lookups run AS the shopkeeper, so RLS (order_files_select_shop) and the
 * Storage policy (print_files_select_shop) decide — another shop's file id
 * simply finds nothing; the profile's shop id is checked again on top. Order:
 *  1. refuse closed orders and unpaid ONLINE ones;
 *  2. sign the URL — if that fails, the order is left as it was;
 *  3. move it to PRINTING as a compare-and-set, so a re-download or a second
 *     tab updates nothing: orders_lifecycle writes printing_at once and
 *     orders_notify sends the "being printed" notice once.
 * Step 3 is the ONLY way into PRINTING: orders_guard refuses it from every API
 * role, so it goes through start_printing (service role only), pinned to this
 * shop, this order and the from-statuses below.
 * The server can't see whether the browser finished saving the file (or that
 * it was printed): PRINTING means a valid download was handed over.
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
    // RLS already hides unpaid online orders from shops; fail closed here too.
    if (order.payment_method !== "PAY_AT_COUNTER" && order.payment_status !== "PAID") {
      return errorResponse(SAFE.unpaid);
    }

    const { data: signed } = await supabase.storage
      .from("print-files")
      .createSignedUrl(file.storage_path, 60, { download: file.original_name });
    if (!signed?.signedUrl) return errorResponse(SAFE.downloadFailed);

    const from = printFrom(order.payment_method);
    if (from.includes(order.status)) {
      const { data: started, error } = await createAdminClient().rpc("start_printing", {
        p_order_id: order.id,
        p_shop_id: shopId,
      });
      if (error) logServerError("api/shop/files:printing", error);
      // ponytail: a concurrent change (other tab) lands here too; the shop refreshes and re-downloads.
      if (error || started !== true) return errorResponse(error ? mapDbError(error, SAFE.statusFailed) : SAFE.statusFailed);
    }

    return Response.json({ url: signed.signedUrl });
  });
}

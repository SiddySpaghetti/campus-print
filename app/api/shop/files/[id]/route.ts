import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, SAFE } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUuidParam } from "@/lib/server/validate";

/**
 * Download a file of one of the shopkeeper's orders: redirects to a 60-second
 * signed URL. Both lookups run AS the shopkeeper, so RLS
 * (order_files_select_shop) and the Storage policy (print_files_select_shop)
 * decide — another shop's file id simply finds nothing.
 */
export function GET(_request: Request, ctx: RouteContext<"/api/shop/files/[id]">) {
  return handle("api/shop/files", async () => {
    const { supabase, user } = await requireRole("shopkeeper");
    const fileId = parseUuidParam((await ctx.params).id);

    const limited = await rateLimit(`shop_file:${user.id}`, 200, 600);
    if (limited) return limited;

    const { data: file } = await supabase
      .from("order_files")
      .select("storage_path, original_name, file_deleted_at")
      .eq("id", fileId)
      .maybeSingle();
    if (!file || file.file_deleted_at) return errorResponse(SAFE.notFound);

    const { data: signed } = await supabase.storage
      .from("print-files")
      .createSignedUrl(file.storage_path, 60, { download: file.original_name });
    if (!signed?.signedUrl) return errorResponse(SAFE.notFound);

    return Response.redirect(signed.signedUrl, 303);
  });
}

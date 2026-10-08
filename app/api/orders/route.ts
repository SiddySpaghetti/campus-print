import { requireRole } from "@/lib/server/auth";
import { errorResponse, handle, logServerError, mapDbError, readJson, SAFE } from "@/lib/server/errors";
import { FileRejected, inspectFile } from "@/lib/server/file-inspect";
import { rateLimit } from "@/lib/server/rate-limit";
import { MAX_FILE_BYTES, parseCreateOrder } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Create an order.
 *
 * The browser sends ONLY: shop id, print options, copies, an optional note and
 * the storage paths it got from POST /api/uploads. It cannot send a price,
 * total, rate, page count, size or MIME type — unknown fields are rejected.
 *
 * Here the server: authenticates the student, downloads each file from private
 * Storage, checks the real bytes (magic bytes, size, extension, page count with
 * a real PDF parser) and only then calls create_order_verified, which prices
 * the order from the database's shop_pricing. That function is executable by
 * the service role only, so there is no way to reach it with a made-up page
 * count.
 */
export function POST(request: Request) {
  return handle("api/orders", async () => {
    const { user } = await requireRole("student");

    // Inspecting files is expensive; cap attempts per user.
    const limited = await rateLimit(`order_attempt:${user.id}`, 30, 3600);
    if (limited) return limited;

    const input = parseCreateOrder(await readJson(request), user.id);
    const admin = createAdminClient();

    const files = [];
    for (const f of input.files) {
      const { data: blob, error } = await admin.storage.from("print-files").download(f.path);
      if (error || !blob || blob.size > MAX_FILE_BYTES) throw new FileRejected("download");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ext = f.path.slice(f.path.lastIndexOf(".") + 1);
      const info = await inspectFile(bytes, ext);
      files.push({
        storage_path: f.path,
        original_name: f.name,
        mime_type: info.mime,
        size_bytes: info.sizeBytes,
        page_count: info.pageCount,
      });
    }

    const { data, error } = await admin.rpc("create_order_verified", {
      p_user_id: user.id,
      p_shop_id: input.shopId,
      p_colour_mode: input.colour,
      p_paper_size: input.paper,
      p_sides: input.sides,
      p_copies: input.copies,
      p_files: files,
      p_student_note: input.note,
    });
    if (error || !data) {
      logServerError("api/orders:create", error);
      return errorResponse(mapDbError(error ?? {}, SAFE.createFailed));
    }

    const order = data as {
      id: string;
      status: string;
      payment_status: string;
      total_pages: number;
      sheets: number;
      rate_per_sheet_paise: number;
      total_paise: number;
    };
    return Response.json(
      {
        order: {
          id: order.id,
          status: order.status,
          paymentStatus: order.payment_status,
          totalPages: order.total_pages,
          sheets: order.sheets,
          ratePerSheetPaise: order.rate_per_sheet_paise,
          totalPaise: order.total_paise,
        },
      },
      { status: 201 },
    );
  });
}

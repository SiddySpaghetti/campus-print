/**
 * Server-side reading of an order's uploaded files and its price, shared by
 * POST /api/orders and POST /api/orders/quote so the price shown before placing
 * an order comes from the same bytes and the same SQL as the order itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { FileRejected, inspectFile } from "./file-inspect";
import { MAX_FILE_BYTES, MAX_ORDER_BYTES, type CreateOrderInput } from "./validate";

export type VerifiedFile = {
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
};

/** Downloads each file from private Storage and counts its pages, in the student's order. */
export async function inspectOrderFiles(admin: SupabaseClient, files: CreateOrderInput["files"]): Promise<VerifiedFile[]> {
  const verified: VerifiedFile[] = [];
  let total = 0;
  // ponytail: one at a time keeps memory flat; cache inspections if large orders hit the function timeout.
  for (const f of files) {
    const { data: blob, error } = await admin.storage.from("print-files").download(f.path);
    if (error || !blob || blob.size > MAX_FILE_BYTES) throw new FileRejected("download");
    total += blob.size;
    if (total > MAX_ORDER_BYTES) throw new FileRejected("order size");
    const info = await inspectFile(new Uint8Array(await blob.arrayBuffer()), f.path.slice(f.path.lastIndexOf(".") + 1));
    verified.push({
      storage_path: f.path,
      original_name: f.name,
      mime_type: info.mime,
      size_bytes: info.sizeBytes,
      page_count: info.pageCount,
    });
  }
  return verified;
}

export type OrderQuote = { unit: "sheet" | "page"; ratePaise: number; totalPages: number; sheets: number; totalPaise: number };

/** The database's price for these verified page counts (public.quote_order). */
export function quoteOrder(admin: SupabaseClient, input: CreateOrderInput, files: VerifiedFile[]) {
  return admin.rpc("quote_order", {
    p_shop_id: input.shopId,
    p_colour_mode: input.colour,
    p_paper_size: input.paper,
    p_sides: input.sides,
    p_copies: input.copies,
    p_pages: files.map((f) => f.page_count),
  });
}

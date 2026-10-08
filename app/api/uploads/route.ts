import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/server/auth";
import { handle, readJson } from "@/lib/server/errors";
import { rateLimit } from "@/lib/server/rate-limit";
import { parseUploadRequest } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Step 1 of an upload: the browser asks for permission to upload ONE file.
 * The server chooses the storage path (`<user-id>/<uuid>/<uuid>.<ext>`), so the
 * browser can never pick another user's folder, the bucket root or an existing
 * file. It gets back a single-use signed upload URL for exactly that path.
 *
 * The bucket itself enforces the 25 MB limit and the PDF/PNG/JPEG MIME list;
 * the real bytes are re-checked (magic bytes, size, page count) in POST
 * /api/orders before an order can reference the file.
 */
export function POST(request: Request) {
  return handle("api/uploads", async () => {
    const { user } = await requireRole("student");

    const limited = await rateLimit(`upload:${user.id}`, 30, 3600);
    if (limited) return limited;

    const input = parseUploadRequest(await readJson(request));
    const path = `${user.id}/${randomUUID()}/${randomUUID()}.${input.ext}`;

    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from("print-files")
      .createSignedUploadUrl(path);
    if (error || !data) throw error ?? new Error("no signed upload url");

    return Response.json({ path, token: data.token });
  });
}

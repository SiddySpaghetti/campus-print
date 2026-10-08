import { requireRole } from "@/lib/server/auth";
import { handle, readJson } from "@/lib/server/errors";
import { FileRejected, inspectFile } from "@/lib/server/file-inspect";
import { rateLimit } from "@/lib/server/rate-limit";
import { isOwnedStoragePath, MAX_FILE_BYTES, ValidationError } from "@/lib/server/validate";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Step 2 of an upload: check the bytes the browser just put in Storage, using
 * the SAME inspection POST /api/orders runs. Gives the student the real page
 * count for the estimate, and rejects a bad file now rather than at checkout.
 * A rejected file is deleted. This is display only: /api/orders re-inspects.
 */
export function POST(request: Request) {
  return handle("api/uploads/inspect", async () => {
    const { user } = await requireRole("student");

    const limited = await rateLimit(`upload_inspect:${user.id}`, 60, 3600);
    if (limited) return limited;

    const body = (await readJson(request)) as { path?: unknown } | null;
    if (!body || Object.keys(body).some((k) => k !== "path")) throw new ValidationError("unexpected field");
    const path = body.path;
    if (!isOwnedStoragePath(path, user.id)) throw new ValidationError("invalid file path");

    const bucket = createAdminClient().storage.from("print-files");
    const { data: blob, error } = await bucket.download(path);
    if (error || !blob || blob.size > MAX_FILE_BYTES) throw new FileRejected("download");

    try {
      const info = await inspectFile(new Uint8Array(await blob.arrayBuffer()), path.slice(path.lastIndexOf(".") + 1));
      return Response.json({ pageCount: info.pageCount });
    } catch (e) {
      await bucket.remove([path]);
      throw e;
    }
  });
}

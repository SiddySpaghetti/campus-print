/**
 * Server-side inspection of an uploaded file's real bytes. Nothing the browser
 * says about a file (name, MIME type, size, page count) is trusted: this module
 * derives all of it from the content.
 */
import { PDFDocument } from "pdf-lib";

import { MAX_FILE_BYTES, type AllowedMime } from "./validate";

export const MAX_PDF_PAGES = 500;

export class FileRejected extends Error {
  name = "FileRejected";
}

export type InspectedFile = {
  mime: AllowedMime;
  sizeBytes: number;
  pageCount: number;
};

/** Magic-byte sniffing. Returns null for anything that is not PDF/PNG/JPEG. */
export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // A PDF header may be preceded by a little junk, but must be in the first KB.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return "application/pdf";
  return null;
}

/**
 * Authoritative page count. Images are one page. PDFs are parsed with a real
 * parser (it understands compressed object streams, unlike a regex); a PDF that
 * cannot be parsed, is encrypted, or has too many pages is rejected, never
 * "estimated".
 */
export async function inspectFile(
  bytes: Uint8Array,
  expectedExtension: string,
): Promise<InspectedFile> {
  if (bytes.length < 1 || bytes.length > MAX_FILE_BYTES) {
    throw new FileRejected("size");
  }
  const mime = sniffMime(bytes);
  if (!mime) throw new FileRejected("type");

  const extOk =
    (mime === "application/pdf" && expectedExtension === "pdf") ||
    (mime === "image/png" && expectedExtension === "png") ||
    (mime === "image/jpeg" && (expectedExtension === "jpg" || expectedExtension === "jpeg"));
  if (!extOk) throw new FileRejected("extension mismatch");

  if (mime !== "application/pdf") {
    return { mime, sizeBytes: bytes.length, pageCount: 1 };
  }

  let pageCount: number;
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false, // encrypted PDFs throw: we cannot count or print them
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    pageCount = doc.getPageCount();
  } catch {
    throw new FileRejected("unreadable pdf");
  }
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new FileRejected("page count");
  }
  return { mime, sizeBytes: bytes.length, pageCount };
}

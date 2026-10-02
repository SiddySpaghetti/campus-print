/**
 * Works out how many printable pages a chosen document has, with no extra
 * dependencies.
 *
 * Images are always one page. PDFs are scanned for the page objects the format
 * stores in plain text, which covers ordinary documents without pulling in a
 * parser. PDFs that keep their page tree inside a compressed object stream
 * (common in PDF 1.5+ output) can't be read this way, so those fall back to a
 * fixed estimate that the UI labels as such.
 */
import { DEMO_PAGE_COUNT } from "@/lib/pricing";

export type PageCountSource = "image" | "pdf" | "estimate";

export type PageCountResult = {
  pageCount: number;
  source: PageCountSource;
};

/** Scan at most this much of a PDF; well beyond our 25 MB upload cap. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export async function resolvePageCount(file: File): Promise<PageCountResult> {
  if (file.type === "image/png" || file.type === "image/jpeg") {
    return { pageCount: 1, source: "image" };
  }

  if (file.type === "application/pdf") {
    const counted = await countPdfPages(file);
    if (counted !== null) return { pageCount: counted, source: "pdf" };
  }

  return { pageCount: DEMO_PAGE_COUNT, source: "estimate" };
}

/** Returns null when the structure isn't readable as plain bytes. */
async function countPdfPages(file: File): Promise<number | null> {
  let text: string;
  try {
    const buffer = await file.slice(0, MAX_SCAN_BYTES).arrayBuffer();
    // latin1 maps each byte to one char, so offsets and markers survive intact.
    text = new TextDecoder("latin1").decode(buffer);
  } catch {
    return null;
  }

  // Each page is an object declaring `/Type /Page` — but not `/Pages`, which
  // is the tree node above them.
  const pageObjects = text.match(/\/Type\s*\/Page(?![\w])/g);
  if (pageObjects && pageObjects.length > 0) return pageObjects.length;

  // Otherwise trust the page tree root's `/Count`. Linearised files repeat it
  // per subtree, so the largest value is the document total.
  const counts = Array.from(text.matchAll(/\/Count\s+(\d+)/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (counts.length > 0) return Math.max(...counts);

  return null;
}

export function formatPageCount(pageCount: number) {
  return `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

export function formatSheetCount(sheets: number) {
  return `${sheets} ${sheets === 1 ? "sheet" : "sheets"}`;
}

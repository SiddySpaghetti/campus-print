/**
 * Builds the print-ready PDF in the shopkeeper's browser, at print time. Nothing
 * is uploaded or stored, so the originals stay the only copies. Loaded with a
 * dynamic import: pdf-lib is only worth downloading when someone prints.
 *
 * It never omits anything: every document must load and report the page count the
 * server recorded, and the result must have exactly the expected pages. Anything
 * else throws PrintFileError, and the caller falls back to printing file by file.
 */
import { PDFDocument } from "pdf-lib";

import { pageRanges } from "./print-pages";

export type PrintDoc = { name: string; mime: string; pageCount: number; bytes: Uint8Array };
export type PreparedImage = { jpeg: Uint8Array; width: number; height: number };
export type PrintOptions = {
  paper: "a4" | "a3";
  sides: "single" | "double";
  prepareImage?: (doc: PrintDoc) => Promise<PreparedImage>;
};

/** Short and long edge in PDF points. */
const PAPER_POINTS = { a4: [595.28, 841.89], a3: [841.89, 1190.55] } as const;
/** Keeps an image clear of the area printers can't reach, so nothing is cropped. */
const IMAGE_MARGIN = 18;
/** Roughly 350 dpi on A4; browsers refuse very large canvases. */
const MAX_IMAGE_EDGE = 4096;

export class PrintFileError extends Error {
  name = "PrintFileError";
  constructor(public fileName: string) {
    super(`Could not prepare ${fileName}`);
  }
}

/**
 * Decodes through the browser, which applies the photo's rotation (pdf-lib would
 * ignore it and print phone photos sideways), flattens transparency onto white
 * and re-encodes. The stored original is never touched.
 */
async function browserImageToJpeg(doc: PrintDoc): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(new Blob([doc.bytes as BlobPart], { type: doc.mime }), {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("no image");
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width, height };
}

async function addDocument(out: PDFDocument, doc: PrintDoc, paper: PrintOptions["paper"], prepareImage: NonNullable<PrintOptions["prepareImage"]>) {
  if (doc.mime === "application/pdf") {
    const source = await PDFDocument.load(doc.bytes, { updateMetadata: false });
    if (source.getPageCount() !== doc.pageCount) throw new Error("page count differs");
    for (const page of await out.copyPages(source, source.getPageIndices())) out.addPage(page);
    return;
  }
  const image = await prepareImage(doc);
  const embedded = await out.embedJpg(image.jpeg);
  const [short, long] = PAPER_POINTS[paper];
  // The page turns with the image, so a landscape photo fills a landscape page.
  const [pageWidth, pageHeight] = image.width > image.height ? [long, short] : [short, long];
  const scale = Math.min((pageWidth - 2 * IMAGE_MARGIN) / image.width, (pageHeight - 2 * IMAGE_MARGIN) / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  out.addPage([pageWidth, pageHeight]).drawImage(embedded, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  });
}

/** One print-ready PDF for `docs`, in the given order. Throws PrintFileError. */
export async function buildPrintPdf(docs: readonly PrintDoc[], { paper, sides, prepareImage = browserImageToJpeg }: PrintOptions) {
  // A single PDF prints as it came, with no re-serialising to go wrong.
  if (docs.length === 1 && docs[0].mime === "application/pdf") {
    const [doc] = docs;
    let pages = -1;
    try {
      pages = (await PDFDocument.load(doc.bytes, { updateMetadata: false })).getPageCount();
    } catch {
      throw new PrintFileError(doc.name);
    }
    if (pages !== doc.pageCount) throw new PrintFileError(doc.name);
    return doc.bytes;
  }

  const out = await PDFDocument.create();
  const { ranges, totalPages } = pageRanges(docs, sides);
  for (const [index, doc] of docs.entries()) {
    try {
      await addDocument(out, doc, paper, prepareImage);
    } catch {
      throw new PrintFileError(doc.name);
    }
    if (ranges[index].blankAfter) {
      const last = out.getPage(out.getPageCount() - 1).getSize();
      out.addPage([last.width, last.height]);
    }
  }
  if (out.getPageCount() !== totalPages) throw new PrintFileError(docs[docs.length - 1].name);
  return out.save();
}

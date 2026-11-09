/** Print-ready PDF, page mapping and who-may-do-what rules. Run: npm run test:security */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PDFDocument } from "pdf-lib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PrintOrder } from "../components/flow/print-order";
import { awaitsPrintConfirmation, canOpenFiles, canPrint, canStudentCancel, canStudentPay, shopStage } from "../lib/orders";
import { pageRanges } from "../lib/print-pages";
import { buildPrintPdf, PrintFileError, type PrintDoc } from "../lib/print-pdf";

/** N pages, each `width` wide: the width identifies which document a page came from. */
async function pdf(name: string, pages: number, width: number): Promise<PrintDoc> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width, 800]);
  return { name, mime: "application/pdf", pageCount: pages, bytes: await doc.save() };
}

/** The smallest JPEG header pdf-lib will embed: it reads the size, it doesn't decode. */
function jpeg(width: number, height: number) {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
}
const image = (name: string): PrintDoc => ({ name, mime: "image/jpeg", pageCount: 1, bytes: new Uint8Array([1]) });
const prepare = (width: number, height: number) => async () => ({ jpeg: jpeg(width, height), width, height });
const widths = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));

describe("page mapping", () => {
  const docs = [{ name: "a", pageCount: 3 }, { name: "b", pageCount: 2 }, { name: "c", pageCount: 1 }];
  it("single-sided: consecutive, no blanks", () => {
    const { ranges, totalPages } = pageRanges(docs, "single");
    assert.deepEqual(ranges.map((r) => [r.first, r.last, r.blankAfter]), [[1, 3, false], [4, 5, false], [6, 6, false]]);
    assert.equal(totalPages, 6);
  });
  it("double-sided: a blank after an odd document so the next starts on a new sheet, none after the last", () => {
    const { ranges, totalPages } = pageRanges(docs, "double");
    assert.deepEqual(ranges.map((r) => [r.first, r.last, r.blankAfter]), [[1, 3, true], [5, 6, false], [7, 7, false]]);
    assert.equal(totalPages, 7);
  });
});

describe("combined PDF", () => {
  it("keeps the student's order and every page", async () => {
    const out = await buildPrintPdf([await pdf("b", 2, 200), await pdf("a", 1, 100), await pdf("c", 3, 300)], { paper: "a4", sides: "single" });
    assert.deepEqual(await widths(out), [200, 200, 100, 300, 300, 300]);
  });

  it("double-sided pads with a blank page the same size as the document before it", async () => {
    const out = await buildPrintPdf([await pdf("a", 3, 100), await pdf("b", 2, 200), await pdf("c", 1, 300)], { paper: "a4", sides: "double" });
    assert.deepEqual(await widths(out), [100, 100, 100, 100, 200, 200, 300]);
  });

  it("images become one page, turned to match, inside the margins and with the aspect ratio kept", async () => {
    const out = await buildPrintPdf([image("wide.jpg"), await pdf("a", 1, 100)], { paper: "a4", sides: "single", prepareImage: prepare(4000, 1000) });
    const page = (await PDFDocument.load(out)).getPage(0);
    assert.equal(Math.round(page.getWidth()), 842, "landscape A4 for a landscape image");
    assert.equal(Math.round(page.getHeight()), 595);
    assert.equal((await PDFDocument.load(out)).getPageCount(), 2);
  });

  it("A3 orders get A3 image pages; portrait stays portrait", async () => {
    const out = await buildPrintPdf([image("tall.jpg"), image("tall2.jpg")], { paper: "a3", sides: "single", prepareImage: prepare(1000, 2000) });
    const page = (await PDFDocument.load(out)).getPage(0);
    assert.deepEqual([Math.round(page.getWidth()), Math.round(page.getHeight())], [842, 1191]);
  });

  it("a single PDF passes through byte for byte", async () => {
    const doc = await pdf("a", 2, 100);
    assert.equal(await buildPrintPdf([doc], { paper: "a4", sides: "double" }), doc.bytes);
  });

  it("never omits: an unreadable file or a changed page count fails, naming the file", async () => {
    const good = await pdf("good.pdf", 1, 100);
    const broken = { ...good, name: "broken.pdf", bytes: new Uint8Array([1, 2, 3]) };
    const wrongCount = { ...(await pdf("short.pdf", 2, 100)), pageCount: 3 };
    for (const [docs, name] of [
      [[good, broken], "broken.pdf"],
      [[wrongCount, good], "short.pdf"],
      [[broken], "broken.pdf"],
      [[wrongCount], "short.pdf"],
    ] as const) {
      await assert.rejects(buildPrintPdf(docs, { paper: "a4", sides: "single" }), (e: unknown) => e instanceof PrintFileError && e.fileName === name);
    }
    const failing = async () => {
      throw new Error("can't decode");
    };
    await assert.rejects(buildPrintPdf([good, image("photo.jpg")], { paper: "a4", sides: "single", prepareImage: failing }), (e: unknown) => e instanceof PrintFileError && e.fileName === "photo.jpg");
  });
});

describe("Print document panel", () => {
  const render = (confirms: boolean) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: {} as never },
        createElement(PrintOrder, {
          orderId: "o1",
          confirms,
          paper: "a4",
          sides: "double",
          settings: "2 copies · Double-sided · B&W · A4",
          files: [{ id: "f1", original_name: "notes.pdf", page_count: 3 }, { id: "f2", original_name: "photo.jpg", page_count: 1 }],
        }),
      ),
    );

  it("offers Print document with the settings and page mapping, and claims nothing has printed", () => {
    const html = render(true);
    for (const text of ["Print document", "2 copies", "Pages 1-3: notes.pdf", "then a blank page", "Page 5: photo.jpg", "5 pages in the combined PDF"]) {
      assert.ok(html.includes(text), text);
    }
    assert.equal(html.includes("Printing started"), false, "only offered after a print request");
  });

  it("is a reprint once the order is already printing", () => {
    assert.ok(render(false).includes("Reprint"));
  });
});

describe("workflow rules (mirrors of the SQL, which stays the authority)", () => {
  const online = (status: "PENDING" | "ACCEPTED" | "PRINTING" | "READY" | "COMPLETED" | "CANCELLED", payment_status: string, accept_first = true) =>
    ({ status, payment_status, payment_method: "ONLINE", accept_first });
  const counter = (status: "PENDING" | "ACCEPTED" | "PRINTING") => ({ status, payment_status: "PENDING", payment_method: "PAY_AT_COUNTER", accept_first: true });

  it("unpaid online orders can't be opened or printed, accepted or not", () => {
    for (const payment of ["PENDING", "FAILED"]) {
      for (const status of ["PENDING", "ACCEPTED"] as const) {
        assert.equal(canOpenFiles(online(status, payment)), false);
        assert.equal(canPrint(online(status, payment)), false);
      }
    }
    assert.equal(canPrint(online("CANCELLED", "REFUND_PENDING")), false);
    assert.equal(canPrint(online("ACCEPTED", "PAID")), true);
    assert.equal(canPrint(online("PENDING", "PAID", false)), true, "legacy paid order");
    assert.equal(canPrint(online("PENDING", "PAID", true)), false, "accept-then-pay must be accepted");
  });

  it("paying: only once accepted; legacy orders while pending; never a counter order", () => {
    assert.equal(canStudentPay(online("PENDING", "PENDING")), false);
    assert.equal(canStudentPay(online("ACCEPTED", "PENDING")), true);
    assert.equal(canStudentPay(online("ACCEPTED", "FAILED")), true);
    assert.equal(canStudentPay(online("ACCEPTED", "PAID")), false);
    assert.equal(canStudentPay(online("PENDING", "PENDING", false)), true);
    assert.equal(canStudentPay(online("ACCEPTED", "PENDING", false)), false);
    assert.equal(canStudentPay(counter("PENDING")), false);
  });

  it("cancelling: online until printing starts, paid or not; counter only while pending", () => {
    assert.equal(canStudentCancel(online("PENDING", "PENDING")), true);
    assert.equal(canStudentCancel(online("ACCEPTED", "PENDING")), true);
    assert.equal(canStudentCancel(online("ACCEPTED", "PAID")), true);
    assert.equal(canStudentCancel(online("PRINTING", "PAID")), false);
    assert.equal(canStudentCancel(online("READY", "PAID")), false);
    assert.equal(canStudentCancel(counter("PENDING")), true);
    assert.equal(canStudentCancel(counter("ACCEPTED")), false);
  });

  it("a reprint needs no second confirmation, and each order sits in one queue", () => {
    assert.equal(awaitsPrintConfirmation(online("ACCEPTED", "PAID")), true);
    assert.equal(awaitsPrintConfirmation(online("PRINTING", "PAID")), false);
    assert.equal(canPrint(online("PRINTING", "PAID")), true);
    assert.equal(shopStage(online("PENDING", "PENDING")), "decide");
    assert.equal(shopStage(online("ACCEPTED", "PENDING")), "awaiting_payment");
    assert.equal(shopStage(online("ACCEPTED", "PAID")), "print");
    assert.equal(shopStage(online("PENDING", "PAID", false)), "print");
    assert.equal(shopStage(counter("PENDING")), "decide");
    assert.equal(shopStage(counter("ACCEPTED")), "print");
    assert.equal(shopStage(online("PRINTING", "PAID")), "in_progress");
  });
});

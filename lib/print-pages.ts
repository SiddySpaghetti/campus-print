/**
 * Where each document lands in the combined print PDF. Derived only from the
 * student's file order and the server-counted pages, so the mapping needs no
 * storage and can't drift from the originals.
 *
 * Double-sided: a blank page after an odd-length document (except the last), so
 * the next document starts on its own sheet. That is also how create_order_verified
 * charges (each document rounds up to whole sheets). Blanks are never billed.
 */
export type PageRange = { name: string; first: number; last: number; blankAfter: boolean };

export function pageRanges(docs: readonly { name: string; pageCount: number }[], sides: "single" | "double") {
  let next = 1;
  const ranges: PageRange[] = docs.map((doc, index) => {
    const first = next;
    const last = first + doc.pageCount - 1;
    const blankAfter = sides === "double" && doc.pageCount % 2 === 1 && index < docs.length - 1;
    next = last + 1 + (blankAfter ? 1 : 0);
    return { name: doc.name, first, last, blankAfter };
  });
  return { ranges, totalPages: next - 1 };
}

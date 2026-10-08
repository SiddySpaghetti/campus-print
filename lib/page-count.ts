/** Display helpers. Page counts come from the server (POST /api/uploads/inspect). */
export function formatPageCount(pageCount: number) {
  return `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

export function formatSheetCount(sheets: number) {
  return `${sheets} ${sheets === 1 ? "sheet" : "sheets"}`;
}

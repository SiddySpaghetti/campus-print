"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/api-client";
import { formatPageCount } from "@/lib/page-count";
import { pageRanges } from "@/lib/print-pages";
import type { PrintDoc } from "@/lib/print-pdf";

type PrintResponse = {
  files: { id: string; name: string; mime: string; pageCount: number; url: string }[];
  previouslyRequestedAt: string | null;
};

/** Two documents may share a name, so progress is tracked by file id. */
type LoadedDoc = PrintDoc & { id: string };
type Phase = "idle" | "preparing" | "requested";

/** Within this, another tab or device may still have its dialog open. */
const RECENT_REQUEST_MS = 10 * 60_000;
const isRecent = (iso: string) => Date.now() - Date.parse(iso) < RECENT_REQUEST_MS;
/** Survives the card moving between queue sections, so a tab's own reprint isn't questioned. */
const requestedInThisTab = new Set<string>();

/**
 * The Print Document action. Keeps three things apart, because a browser can't
 * see the printer:
 *  1. Print requested: the server checks the order and records the request; the
 *     browser fetches the files and opens the native print dialog. Status is
 *     unchanged and the student is told nothing, even if the dialog is cancelled.
 *  2. Printing started: only when the shopkeeper says so, which moves the order to
 *     PRINTING and notifies the student.
 *  3. It didn't print: nothing changes, so it can simply be tried again.
 *
 * The dialog can't be pre-filled by a web page, so the settings to choose are
 * spelled out here. Several documents become one PDF in this browser; if that
 * fails, each one can be printed by itself and none is dropped silently.
 */
export function PrintOrder({
  orderId,
  confirms,
  paper,
  sides,
  settings,
  files,
}: {
  orderId: string;
  /** False for a reprint: the order is already PRINTING or READY. */
  confirms: boolean;
  paper: "a4" | "a3";
  sides: "single" | "double";
  settings: string;
  files: { id: string; original_name: string; page_count: number }[];
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Set when the combined PDF couldn't be built: print these one by one. */
  const [individual, setIndividual] = useState<LoadedDoc[] | null>(null);
  const [printed, setPrinted] = useState<string[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  const { ranges, totalPages } = pageRanges(files.map((f) => ({ name: f.original_name, pageCount: f.page_count })), sides);

  useEffect(() => {
    return () => {
      frame.current?.remove();
    };
  }, []);
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  /**
   * Opens the native dialog from a same-origin blob, which is the only way a page
   * may print a PDF. The type is always application/pdf: the bytes were verified
   * as PDF by the server and images were rebuilt here, so nothing a student
   * uploaded can run as a page on our origin. Reports only whether the dialog was
   * asked to open, never whether anything printed.
   */
  const openDialog = (bytes: Uint8Array) =>
    new Promise<void>((resolve) => {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      setPdfUrl(url);
      frame.current?.remove();
      const iframe = document.createElement("iframe");
      // Not display:none: browsers won't load a PDF viewer in that.
      iframe.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0";
      iframe.title = "Print preview";
      iframe.src = url;
      frame.current = iframe;
      const timeout = window.setTimeout(resolve, 15_000);
      iframe.onload = () => {
        window.clearTimeout(timeout);
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } catch {
          // The "Open the PDF" link below still works.
        }
        resolve();
      };
      document.body.appendChild(iframe);
    });

  const start = async () => {
    setPhase("preparing");
    setError(null);
    setIndividual(null);
    setPrinted([]);
    try {
      const response = await postJson<PrintResponse>(`/api/shop/orders/${orderId}/print`);
      const previous = response.previouslyRequestedAt;
      if (
        !requestedInThisTab.has(orderId) &&
        previous &&
        isRecent(previous) &&
        !window.confirm("The print dialog for this order was opened a few minutes ago, so printing again could make a duplicate. Open it again?")
      ) {
        setPhase("idle");
        return;
      }
      requestedInThisTab.add(orderId);

      const docs: LoadedDoc[] = [];
      for (const f of response.files) {
        const res = await fetch(f.url).catch(() => null);
        if (!res?.ok) throw new Error(`${f.name} couldn't be loaded. Nothing was marked as printing. Try again.`);
        docs.push({ id: f.id, name: f.name, mime: f.mime, pageCount: f.pageCount, bytes: new Uint8Array(await res.arrayBuffer()) });
      }

      const { buildPrintPdf } = await import("@/lib/print-pdf");
      try {
        await openDialog(await buildPrintPdf(docs, { paper, sides }));
      } catch {
        setIndividual(docs);
      }
      setPhase("requested");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The document couldn't be prepared. Nothing was marked as printing.");
      setPhase("idle");
    }
  };

  const printOne = async (doc: LoadedDoc) => {
    setError(null);
    try {
      const { buildPrintPdf } = await import("@/lib/print-pdf");
      await openDialog(await buildPrintPdf([doc], { paper, sides }));
      setPrinted((ids) => (ids.includes(doc.id) ? ids : [...ids, doc.id]));
    } catch {
      setError(`${doc.name} can't be printed from here. Open the original above, or cancel the order.`);
    }
  };

  const confirmStarted = async () => {
    const missing = individual?.filter((d) => !printed.includes(d.id)).map((d) => d.name) ?? [];
    if (missing.length > 0 && !window.confirm(`Not printed yet: ${missing.join(", ")}. Mark the order as printing anyway?`)) return;
    setSaving(true);
    setError(null);
    try {
      await postJson(`/api/shop/orders/${orderId}/printing`);
      setPhase("idle");
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record that printing started.");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setPhase("idle");
    setIndividual(null);
    setPrinted([]);
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {phase !== "requested" ? (
          <Button type="button" disabled={phase === "preparing" || refreshing} onClick={start}>
            {phase === "preparing" ? "Preparing…" : confirms ? "Print document" : "Reprint"}
          </Button>
        ) : null}
        <span className="text-[13px] text-muted-foreground">Set in the print dialog: {settings}</span>
      </div>

      {files.length > 1 ? (
        <ol className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
          {ranges.map((r, index) => (
            <li key={files[index].id} className="[overflow-wrap:anywhere]">
              Page{r.first === r.last ? ` ${r.first}` : `s ${r.first}-${r.last}`}: {r.name}
              {r.blankAfter ? ", then a blank page so the next document starts on its own sheet" : ""}
            </li>
          ))}
          <li>{formatPageCount(totalPages)} in the combined PDF</li>
        </ol>
      ) : null}

      {phase === "requested" ? (
        <div role="status" className="flex flex-col gap-2 rounded-card border border-line bg-paper-deep p-3 text-[13px] text-ink">
          {individual ? (
            <>
              <p className="font-medium">
                These documents couldn&apos;t be combined into one PDF. Print each one; all of them still belong to this order.
              </p>
              <ul className="flex flex-col gap-1.5">
                {individual.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => printOne(doc)}>
                      {printed.includes(doc.id) ? "Print again" : "Print"}
                    </Button>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {doc.name} · {formatPageCount(doc.pageCount)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="font-medium">Print requested. The print dialog should be open; it doesn&apos;t tell us whether anything printed.</p>
          )}
          <p>
            <span className="font-medium">Check these in the dialog:</span> {settings}. A web page can&apos;t set them, and the dialog may
            start on other settings, such as Letter paper or one-sided.
          </p>
          {pdfUrl ? (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="w-fit font-medium underline decoration-line underline-offset-4 hover:decoration-ink">
              No dialog? Open the PDF to print it
            </a>
          ) : null}
          {confirms ? (
            <>
              <p>Tell us only once the printer has actually started. The student is notified then.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={saving || refreshing} onClick={confirmStarted}>
                  {saving ? "Saving…" : "Printing started"}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={reset}>
                  It didn&apos;t print
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={reset}>
                Done
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

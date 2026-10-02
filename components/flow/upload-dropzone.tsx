"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FileText, UploadCloud, X } from "lucide-react";

import { DrawCheck } from "@/components/flow/draw-check";
import { useFlow } from "@/components/flow/flow-state";
import { Button } from "@/components/ui/button";
import { formatPageCount, resolvePageCount } from "@/lib/page-count";
import {
  ACCEPTED_FILE_HINT,
  ACCEPTED_FILE_TYPES,
  fileKindLabel,
  formatFileSize,
} from "@/lib/pricing";
import { cn } from "@/lib/utils";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const MAX_BYTES = 25 * 1024 * 1024;

/** Paper settling: a touch of overshoot, then still. */
const SETTLE = {
  type: "spring",
  stiffness: 230,
  damping: 21,
  mass: 0.8,
} as const;

/**
 * Local document picker: drag-and-drop plus a file input, following the
 * 21st.dev "File Dropzone" (#19201) pattern — drag state on the zone, type and
 * size validation, then a card for the chosen file.
 *
 * The chosen document behaves like a sheet of paper: it comes in from above,
 * slightly rotated, and settles into the tray below the zone.
 *
 * Nothing is uploaded. Only the file's name, type, size and page count are
 * kept, since that is all the rest of the prototype needs.
 */
export function UploadDropzone() {
  const { file, setFile } = useFlow();
  const reduced = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async (incoming: File | undefined) => {
    if (!incoming) return;

    if (!ACCEPTED_FILE_TYPES.includes(incoming.type as (typeof ACCEPTED_FILE_TYPES)[number])) {
      setError(`That file type isn't supported. Choose a ${ACCEPTED_FILE_HINT} file.`);
      return;
    }
    if (incoming.size > MAX_BYTES) {
      setError("That file is larger than 25 MB.");
      return;
    }

    setError(null);
    const { pageCount, source } = await resolvePageCount(incoming);
    setFile({
      name: incoming.name,
      type: incoming.type,
      sizeBytes: incoming.size,
      pageCount,
      pageCountSource: source,
    });
  };

  const clear = () => {
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Dropzone: expands a little and warms up while a file is over it. */}
      <motion.div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void accept(event.dataTransfer.files?.[0]);
        }}
        animate={{ scale: dragging ? 1.012 : 1 }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
        className={cn(
          "relative flex flex-col items-center justify-center overflow-hidden rounded-card border border-dashed text-center transition-[border-color,background-color,padding] duration-200",
          dragging
            ? "border-ink bg-accent/20 px-6 py-14 md:py-20"
            : "border-line bg-card px-6 py-12 md:py-16",
        )}
      >
        {/* Sheet rising out of the slot as you drag over */}
        <div className="relative mb-5 flex h-14 w-14 items-end justify-center">
          <motion.span
            aria-hidden="true"
            className="absolute bottom-0 h-11 w-9 rounded-sm border border-line bg-paper-deep"
            animate={{
              y: dragging ? -10 : 0,
              rotate: dragging ? -7 : 0,
              opacity: dragging ? 1 : 0,
            }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
          />
          <motion.span
            aria-hidden="true"
            className="relative flex size-14 items-center justify-center rounded-2xl border border-line bg-paper-deep text-ink"
            animate={{ y: dragging ? -4 : 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
          >
            <UploadCloud className="size-6" strokeWidth={1.75} />
          </motion.span>
        </div>

        <p className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">
          {dragging ? "Drop it here" : "Drag your document here"}
        </p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {ACCEPTED_FILE_HINT} · up to 25 MB
        </p>

        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-6"
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </Button>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          className="sr-only"
          aria-label="Choose a document to print"
          onChange={(event) => void accept(event.target.files?.[0])}
        />
      </motion.div>

      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}

      {/* Tray: the sheet lands here. Overflow is clipped so it enters from
          above the tray rather than floating over the dropzone. */}
      <AnimatePresence initial={false}>
        {file ? (
          <motion.div
            key="tray"
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
          >
            <motion.div
              className="flex items-center gap-4 rounded-card border border-line bg-card p-4"
              initial={
                reduced
                  ? { opacity: 0 }
                  : { y: -56, rotate: -2.5, opacity: 0, scale: 0.98 }
              }
              animate={{ y: 0, rotate: 0, opacity: 1, scale: 1 }}
              transition={reduced ? { duration: 0.2 } : SETTLE}
            >
              <span
                aria-hidden="true"
                className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-deep text-ink"
              >
                <FileText className="size-5" strokeWidth={1.75} />
              </span>

              <div className="min-w-0 flex-1">
                {/* Metadata arrives once the sheet has settled. */}
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: reduced ? 0 : 0.22, duration: 0.26, ease: EASE_OUT }}
                >
                  <p className="truncate font-medium text-ink">{file.name}</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    {fileKindLabel(file)} · {formatFileSize(file.sizeBytes)} ·{" "}
                    {formatPageCount(file.pageCount)}
                    {file.pageCountSource === "estimate" ? " (estimated)" : null}
                  </p>
                </motion.div>

                <motion.p
                  className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-signal-ready"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: reduced ? 0 : 0.36, duration: 0.24 }}
                >
                  <DrawCheck
                    className="size-4"
                    delay={reduced ? 0 : 0.42}
                    strokeWidth={2.5}
                  />
                  Document ready
                </motion.p>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={clear}
                aria-label={`Remove ${file.name}`}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <p className="text-[13px] text-muted-foreground">
        Your file stays on your device in this prototype — nothing is uploaded yet.
      </p>
    </div>
  );
}

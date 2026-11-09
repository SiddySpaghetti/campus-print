"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, ArrowUp, FileText, UploadCloud, X } from "lucide-react";

import { useFlow } from "@/components/flow/flow-state";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/api-client";
import { formatPageCount } from "@/lib/page-count";
import {
  ACCEPTED_FILE_HINT,
  ACCEPTED_FILE_TYPES,
  fileKindLabel,
  formatFileSize,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ORDER,
  MAX_ORDER_BYTES,
} from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { createClient } from "@/utils/supabase/client";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Paper settling: a touch of overshoot, then still. */
const SETTLE = {
  type: "spring",
  stiffness: 230,
  damping: 21,
  mass: 0.8,
} as const;

/**
 * Document picker: drag-and-drop plus a file input, for one or several files.
 * They upload one at a time, in the order chosen, and each lands as a sheet in
 * the tray below, where the student can reorder or remove it. The printed order
 * is the tray's order.
 *
 * Each file goes up straight away: POST /api/uploads returns a server-chosen path
 * and a single-use signed upload URL token, and the bytes go directly to the
 * private Storage bucket. The server then inspects the stored bytes
 * (/api/uploads/inspect) and returns the real page count, or rejects the file.
 * One bad file doesn't stop the others; it is named below instead.
 */
export function UploadDropzone() {
  const { files, addFile, removeFile, moveFile } = useFlow();
  const reduced = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);

  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const totalPages = files.reduce((sum, f) => sum + f.pageCount, 0);

  const uploadOne = async (incoming: File) => {
    const { path, token } = await postJson<{ path: string; token: string }>("/api/uploads", {
      mime: incoming.type,
      extension: incoming.name.split(".").pop()?.toLowerCase() ?? "",
      sizeBytes: incoming.size,
      name: incoming.name,
    });
    const { error: uploadError } = await createClient()
      .storage.from("print-files")
      .uploadToSignedUrl(path, token, incoming, { contentType: incoming.type });
    if (uploadError) throw new Error("Upload failed. Please try again.");
    // The server reads the stored bytes: real page count, or a rejection.
    const { pageCount } = await postJson<{ pageCount: number }>("/api/uploads/inspect", { path });
    addFile({ name: incoming.name, type: incoming.type, sizeBytes: incoming.size, pageCount, path });
  };

  const accept = async (incoming: readonly File[]) => {
    if (incoming.length === 0 || uploading) return;
    const problems: string[] = [];
    let count = files.length;
    let bytes = totalBytes;
    for (const file of incoming) {
      if (!ACCEPTED_FILE_TYPES.includes(file.type as (typeof ACCEPTED_FILE_TYPES)[number])) {
        problems.push(`${file.name}: that file type isn't supported. Choose a ${ACCEPTED_FILE_HINT} file.`);
      } else if (file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name}: larger than 25 MB.`);
      } else if (count >= MAX_FILES_PER_ORDER) {
        problems.push(`${file.name}: an order can have up to ${MAX_FILES_PER_ORDER} documents.`);
      } else if (bytes + file.size > MAX_ORDER_BYTES) {
        problems.push(`${file.name}: an order can be up to 100 MB in total.`);
      } else {
        count += 1;
        bytes += file.size;
        setUploading(file.name);
        try {
          await uploadOne(file);
        } catch (e) {
          count -= 1;
          bytes -= file.size;
          problems.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed. Please try again."}`);
        }
      }
      setErrors([...problems]);
    }
    setUploading(null);
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
          void accept(Array.from(event.dataTransfer.files ?? []));
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
          {dragging ? "Drop them here" : "Drag your documents here"}
        </p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {ACCEPTED_FILE_HINT} · up to 25 MB each · up to {MAX_FILES_PER_ORDER} documents
        </p>

        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-6"
          disabled={Boolean(uploading)}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? "Uploading…" : "Choose files"}
        </Button>
        {uploading ? (
          <p aria-live="polite" className="mt-2 max-w-full truncate text-[13px] text-muted-foreground">
            Uploading {uploading}
          </p>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg"
          className="sr-only"
          aria-label="Choose documents to print"
          onChange={(event) => void accept(Array.from(event.target.files ?? []))}
        />
      </motion.div>

      {errors.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1 text-[13px] font-medium text-destructive">
          {errors.map((message) => (
            <li key={message} className="[overflow-wrap:anywhere]">
              {message}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Tray: each sheet lands here, in print order. */}
      {files.length > 0 ? (
        <section aria-label="Documents to print, in print order">
          <ol className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {files.map((file, index) => (
                <motion.li
                  key={file.path}
                  layout={!reduced}
                  className="flex items-center gap-3 rounded-card border border-line bg-card p-3 md:gap-4 md:p-4"
                  initial={reduced ? { opacity: 0 } : { y: -24, rotate: -1.5, opacity: 0 }}
                  animate={{ y: 0, rotate: 0, opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={reduced ? { duration: 0.2 } : SETTLE}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-deep text-ink"
                  >
                    <FileText className="size-5" strokeWidth={1.75} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">
                      {index + 1}. {file.name}
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {fileKindLabel(file)} · {formatFileSize(file.sizeBytes)} · {formatPageCount(file.pageCount)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={index === 0}
                      onClick={() => moveFile(file.path, -1)}
                      aria-label={`Move ${file.name} up`}
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={index === files.length - 1}
                      onClick={() => moveFile(file.path, 1)}
                      aria-label={`Move ${file.name} down`}
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        removeFile(file.path);
                        setErrors([]);
                      }}
                      aria-label={`Remove ${file.name}`}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
          <p className="mt-2 text-[13px] font-medium text-ink">
            {files.length} {files.length === 1 ? "document" : "documents"} · {formatPageCount(totalPages)} ·{" "}
            {formatFileSize(totalBytes)}
          </p>
        </section>
      ) : null}

      <p className="text-[13px] text-muted-foreground">
        Files are stored privately. Only you can open them until your order is paid or set to pay at the counter; then the
        shop handling it can too.
      </p>
    </div>
  );
}

"use client";

import { FlowShell } from "@/components/flow/flow-shell";
import { useFlow } from "@/components/flow/flow-state";
import { UploadDropzone } from "@/components/flow/upload-dropzone";

export default function UploadPage() {
  const { file, shop } = useFlow();

  return (
    <FlowShell
      step="upload"
      eyebrow="Step 2 of 6"
      title="Upload your document"
      description={
        shop
          ? `Choose the file you want printed at ${shop.name}.`
          : "Choose the file you want printed."
      }
      entrance="paper"
      back={{ href: "/start-printing" }}
      next={{
        href: "/start-printing/options",
        disabled: !file,
        hint: file ? "Document ready — choose your print settings next." : "Choose a document to continue.",
      }}
    >
      <div className="mx-auto max-w-2xl">
        <UploadDropzone />
      </div>
    </FlowShell>
  );
}

"use client";

import { useAtomValue } from "jotai";
import { uploadProcessingAtom } from "@/lib/global-atoms/uploadProcessingAtoms";
import { Icons } from "@/components/ui";

export default function UploadProcessingBanner() {
  const { active, pendingFiles } = useAtomValue(uploadProcessingAtom);

  if (!active) return null;

  const label =
    pendingFiles === 0
      ? "Processing your files."
      : `Processing ${pendingFiles} ${pendingFiles === 1 ? "file" : "files"}.`;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-primary-80 bg-primary-50/5 mt-2">
      <Icons.Loader className="size-4 text-primary-50 animate-spin shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-grey-10">{label}</span>{" "}
        <span className="text-sm text-grey-50">Sync will start shortly…</span>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";
import { toast } from "sonner";

import { saveAttachmentToDisk, saveErrorMessage } from "@/components/chat/saveAttachment";
import { formatFileSize } from "@/lib/chat/attachments";

interface LightboxProps {
  open: boolean;
  onClose: () => void;
  url: string | null;
  name: string;
  size: number | null;
  senderName: string;
  kind: "image" | "video";
}

/** Full-screen media viewer with download; Esc / click outside closes. */
export default function Lightbox({ open, onClose, url, name, size, senderName, kind }: LightboxProps) {
  const [saving, setSaving] = useState(false);
  const saveToDisk = async (objectUrl: string) => {
    setSaving(true);
    try {
      if ((await saveAttachmentToDisk(objectUrl, name)) === "saved") toast.success(`Saved ${name}`);
    } catch (error) {
      toast.error(saveErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black-900/90 data-[state=open]:animate-fade-in-0.3 dark:bg-black-900/95" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <div className="flex h-14 shrink-0 items-center gap-3 px-4 text-white dark:text-white">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm font-medium">{name}</Dialog.Title>
              <p className="truncate text-xs text-grey-70 dark:text-grey-70">
                {senderName}
                {size !== null ? ` · ${formatFileSize(size)}` : ""}
              </p>
            </div>
            {url ? (
              <button
                type="button"
                onClick={() => void saveToDisk(url)}
                disabled={saving}
                className="inline-flex size-9 items-center justify-center rounded-md text-white hover:bg-white/10 disabled:opacity-50 dark:text-white dark:hover:bg-white/10"
                aria-label="Download"
              >
                <Download className="size-5" aria-hidden />
              </button>
            ) : null}
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="inline-flex size-9 items-center justify-center rounded-md text-white hover:bg-white/10 dark:text-white dark:hover:bg-white/10"
              >
                <X className="size-5" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <div role="presentation" className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
            {!url ? (
              <div className="size-10 animate-spin rounded-full border-2 border-white/30 border-t-white dark:border-white/30 dark:border-t-white" aria-label="Loading" />
            ) : kind === "video" ? (
              <video src={url} controls autoPlay aria-label={name} className="max-h-full max-w-full rounded-md" />
            ) : (
              <img src={url} alt={name} className="max-h-full max-w-full select-none rounded-md object-contain" />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

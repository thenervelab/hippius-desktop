"use client";

import { useEffect, useState } from "react";

import {
  previewByteCap,
  type OfficePreviewFormat,
} from "@/app/lib/utils/filePreviewType";

import { checkPreviewArchive, previewErrorMessage } from "./previewBytes";

export type OfficeArchiveCheck =
  | { status: "checking" }
  | { status: "ok" }
  | { status: "refused"; message: string };

/**
 * Rust's verdict on an Office file before its renderer is mounted.
 *
 * The renderers unzip in the webview, and one malformed `.pptx` used to hang
 * the window inside pptx-viewer's zip reader. Rust refuses such a file in
 * `read_preview_bytes` too, but asking first is what lets the viewer show the
 * download fallback rather than a renderer's in-pane error. Anything that is
 * not an Office format (`format` null) is `ok` without a call.
 */
export function useOfficeArchiveCheck(
  localPath: string | null,
  format: OfficePreviewFormat | null,
): OfficeArchiveCheck {
  const [verdict, setVerdict] = useState<{
    key: string;
    check: OfficeArchiveCheck;
  } | null>(null);
  const key = localPath && format ? `${format}:${localPath}` : null;

  useEffect(() => {
    if (!key || !localPath || !format) return;
    let cancelled = false;
    checkPreviewArchive(localPath, previewByteCap(format), format).then(
      () => {
        if (!cancelled) setVerdict({ key, check: { status: "ok" } });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setVerdict({
          key,
          check: { status: "refused", message: previewErrorMessage(reason) },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, localPath, format]);

  if (!key) return { status: "ok" };
  // A verdict for the previous file never stands in for the current one.
  return verdict?.key === key ? verdict.check : { status: "checking" };
}

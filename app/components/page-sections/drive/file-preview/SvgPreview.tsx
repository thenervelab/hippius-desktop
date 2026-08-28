"use client";

import { useCallback } from "react";

import { MAX_SVG_PREVIEW_BYTES } from "@/app/lib/utils/filePreviewType";
import { sanitizeSvgDocument } from "@/app/lib/utils/preview/sanitizeMarkup";

import { PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewPane } from "./PreviewSurface";
import { decodePlainText } from "./PlainTextPreview";
import { usePreviewResource } from "./usePreviewResource";

/** UTF-8 → base64 without blowing the argument limit on a large file. */
function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function parseSvg(bytes: Uint8Array): string {
  const sanitized = sanitizeSvgDocument(decodePlainText(bytes));
  if (sanitized === null) {
    throw new Error("This file is not a readable SVG image.");
  }
  return `data:image/svg+xml;base64,${toBase64(sanitized)}`;
}

/**
 * SVG rendered inertly, contain-scaled.
 *
 * An `<img>` never runs an SVG's script, never follows its external
 * references and never navigates, which is why the image is not simply handed
 * to the browser as a file URL. The `data:` URL keeps it that way even if a
 * viewer opens the image in a new context: a `data:` document is an opaque
 * origin, unlike a same-origin `blob:` or `asset:` URL. The markup is
 * sanitised first as the second layer (see `sanitizeMarkup`).
 */
export default function SvgPreview({
  localPath,
  filename,
}: {
  localPath: string;
  filename: string;
}) {
  const parse = useCallback(parseSvg, []);
  const state = usePreviewResource(localPath, MAX_SVG_PREVIEW_BYTES, parse);

  if (state.status === "loading") {
    return <PreviewLoading title="Loading image preview…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this SVG"
        description={state.message}
      />
    );
  }

  return (
    <PreviewPane className="items-center justify-center">
      <img
        key={localPath}
        src={state.data}
        alt={filename}
        className="max-h-full max-w-full object-contain animate-scale-in-95-0.4"
      />
    </PreviewPane>
  );
}

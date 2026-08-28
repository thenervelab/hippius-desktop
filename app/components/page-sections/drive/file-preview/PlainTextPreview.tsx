"use client";

import { useCallback } from "react";

import { MAX_STRUCTURED_TEXT_PREVIEW_BYTES } from "@/app/lib/utils/filePreviewType";

import { PreviewEmpty, PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewCard, PreviewPane } from "./PreviewSurface";
import { usePreviewResource } from "./usePreviewResource";

/** Strips a UTF-8 BOM, which would otherwise render as a stray glyph. */
export function decodePlainText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
}

/** TXT rendered as selectable monospaced text on the shared document card. */
export default function PlainTextPreview({ localPath }: { localPath: string }) {
  const parse = useCallback(decodePlainText, []);
  const state = usePreviewResource(
    localPath,
    MAX_STRUCTURED_TEXT_PREVIEW_BYTES,
    parse,
  );

  if (state.status === "loading") {
    return <PreviewLoading title="Loading text preview…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this text file"
        description={state.message}
      />
    );
  }
  if (state.data.length === 0) {
    return <PreviewEmpty title="This text file is empty" />;
  }

  return (
    <PreviewPane>
      <PreviewCard className="mx-auto max-w-5xl">
        <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-6 text-grey-10 dark:text-grey-light-100">
          {state.data}
        </pre>
      </PreviewCard>
    </PreviewPane>
  );
}

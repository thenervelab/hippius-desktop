"use client";

import { useCallback, useState } from "react";

import { previewByteCap } from "@/app/lib/utils/filePreviewType";
import { sanitizeHtmlDocument } from "@/app/lib/utils/preview/sanitizeMarkup";
import { cn } from "@/lib/utils";

import { PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewPane } from "./PreviewSurface";
import { decodePlainText } from "./PlainTextPreview";
import { usePreviewResource } from "./usePreviewResource";

/**
 * All sandbox restrictions on. Notably it grants neither `allow-scripts` (so
 * nothing in the document can execute, sanitised or not) nor
 * `allow-same-origin` (so the frame gets an opaque origin and can reach no
 * app storage, cookies or IPC), and top-level navigation stays blocked — the
 * main WebView is never navigated to the file.
 */
const HTML_PREVIEW_SANDBOX = "";

function parseHtml(bytes: Uint8Array): string {
  return sanitizeHtmlDocument(decodePlainText(bytes));
}

/**
 * HTML rendered as an isolated document.
 *
 * Two independent layers, because this is the format most likely to be
 * hostile: the markup is sanitised (`sanitizeHtmlDocument`) *and* it is
 * displayed in a fully restricted sandboxed frame via `srcdoc`. `srcdoc` is
 * used rather than a `blob:`/`asset:` URL so no navigable URL to the file's
 * content ever exists.
 */
export default function HtmlPreview({
  localPath,
  filename,
}: {
  localPath: string;
  filename: string;
}) {
  const parse = useCallback(parseHtml, []);
  const state = usePreviewResource(localPath, previewByteCap("html"), parse);
  const [frameReady, setFrameReady] = useState(false);

  if (state.status === "loading") {
    return <PreviewLoading title="Loading HTML preview…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this HTML file"
        description={state.message}
      />
    );
  }

  return (
    <PreviewPane>
      <div className="relative flex min-h-0 w-full flex-1">
        <iframe
          key={localPath}
          srcDoc={state.data}
          sandbox={HTML_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          title={filename}
          onLoad={() => setFrameReady(true)}
          className={cn(
            "min-h-0 w-full flex-1 rounded-[8px] border-none bg-white transition-opacity",
            "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
            frameReady ? "opacity-100" : "opacity-0",
          )}
        />
        {!frameReady ? (
          <div className="absolute inset-0 flex">
            <PreviewLoading title="Loading HTML preview…" />
          </div>
        ) : null}
      </div>
    </PreviewPane>
  );
}

"use client";

import { previewByteCap } from "@/app/lib/utils/filePreviewType";

import RenderedFilePreview from "./RenderedFilePreview";

const PAGE_SELECTOR = "section.docx";
const SAFE_LINK = /^(https?:|mailto:|#)/i;

/**
 * docx-preview builds its page DOM with `createElement`, so the only
 * file-controlled attribute that could run script is a hyperlink target. A
 * `javascript:` href in a Word document is otherwise a live click target
 * inside the main WebView.
 */
function sanitizeLinks(body: HTMLElement): void {
  for (const anchor of Array.from(body.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href") ?? "";
    if (!SAFE_LINK.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    if (!href.startsWith("#")) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    }
  }
}

/**
 * Word pages have a fixed physical width (816px for US Letter). Scale the
 * rendered document down when the viewer is narrower, so a narrow window shows
 * a whole page rather than a horizontal scrollbar.
 */
function fitPagesToWidth(body: HTMLDivElement): () => void {
  const wrapper = body.querySelector<HTMLElement>(".docx-wrapper");
  if (!wrapper) return () => {};

  const apply = () => {
    const page = wrapper.querySelector<HTMLElement>(PAGE_SELECTOR);
    const pageWidth = page?.offsetWidth ?? 0;
    const available = body.clientWidth;
    const scale =
      pageWidth > 0 && available > 0 ? Math.min(1, available / pageWidth) : 1;
    wrapper.style.transformOrigin = "top center";
    wrapper.style.transform = scale < 1 ? `scale(${scale})` : "";
    // The transform is visual only, so the layout box is shrunk to match or
    // the scroller would keep the unscaled height.
    body.style.height =
      scale < 1 ? `${Math.ceil(wrapper.offsetHeight * scale)}px` : "";
  };

  apply();
  if (typeof ResizeObserver === "undefined") {
    return () => {
      body.style.height = "";
    };
  }
  const observer = new ResizeObserver(apply);
  observer.observe(body);
  return () => {
    observer.disconnect();
    body.style.height = "";
  };
}

async function renderDocument(
  bytes: Uint8Array,
  body: HTMLDivElement,
  styles: HTMLDivElement,
  signal: AbortSignal,
) {
  // Loaded on demand so docx-preview and its JSZip dependency stay out of the
  // main bundle for the many sessions that never open a Word file.
  const { renderAsync } = await import("docx-preview");
  if (signal.aborted) return;

  try {
    await renderAsync(bytes, body, styles, {
      breakPages: true,
      className: "docx",
      // `experimental` enables docx-preview's unfinished layout paths; leaving
      // it off keeps rendering to the parts it handles correctly.
      experimental: false,
      ignoreFonts: false,
      ignoreHeight: false,
      ignoreLastRenderedPageBreak: false,
      ignoreWidth: false,
      inWrapper: true,
      // Alt chunks embed arbitrary foreign content (including HTML) inside the
      // document part; not rendering them keeps that out of the WebView.
      renderAltChunks: false,
      renderChanges: true,
      renderComments: false,
      renderEndnotes: true,
      renderFooters: true,
      renderFootnotes: true,
      renderHeaders: true,
      useBase64URL: false,
    });
  } catch {
    throw new Error("This Word document could not be opened.");
  }

  if (signal.aborted) return;
  if (!body.querySelector(PAGE_SELECTOR)) {
    throw new Error("This document has no previewable pages.");
  }
  sanitizeLinks(body);
  return fitPagesToWidth(body);
}

/**
 * DOCX rendered as centred, paginated document pages with their own paper
 * colour and drop shadow — the Google Drive / Dropbox presentation, rather
 * than the file's text poured into a generic card.
 */
export default function DocumentPreview({ localPath }: { localPath: string }) {
  return (
    <RenderedFilePreview
      localPath={localPath}
      maxBytes={previewByteCap("document")}
      loadingTitle="Opening document…"
      errorTitle="Couldn't preview this document"
      render={renderDocument}
      pageSelector={PAGE_SELECTOR}
      pageLabel="page"
      bodyClassName="[&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-0 [&_.docx-wrapper>section.docx]:!mb-4 [&_.docx-wrapper>section.docx]:!shadow-[0_2px_12px_rgba(0,0,0,0.14)] [&_.docx-wrapper>section.docx:last-child]:!mb-0"
    />
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import PreviewPager from "./PreviewPager";
import { PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewPane } from "./PreviewSurface";
import { usePagedScroll } from "./usePagedScroll";
import {
  isAbortReason,
  previewErrorMessage,
  readPreviewBytes,
} from "./previewBytes";

type PreviewRenderCleanup = void | (() => void);

export type FilePreviewRenderer = (
  bytes: Uint8Array,
  body: HTMLDivElement,
  styles: HTMLDivElement,
  signal: AbortSignal,
) => PreviewRenderCleanup | Promise<PreviewRenderCleanup>;

/**
 * Lifecycle for renderers that paint into the DOM instead of returning React
 * elements (currently docx-preview).
 *
 * `usePreviewResource` cannot serve these: their output *is* DOM, so the
 * component must own the nodes, clear them on every transition, and undo
 * whatever the renderer installed. Concretely it guarantees:
 *
 *  - The body and the style container are emptied **before** each render and
 *    again on teardown, so a new file never paints under the previous file's
 *    leftovers and a closed viewer leaves nothing behind.
 *  - A render that finishes after its request was aborted runs its own cleanup
 *    and never becomes visible.
 *  - Renderer-installed side effects (a `ResizeObserver`, injected styles) are
 *    returned as a disposer and always called.
 */
export default function RenderedFilePreview({
  localPath,
  maxBytes,
  loadingTitle,
  errorTitle,
  render,
  bodyClassName,
  pageSelector,
  pageLabel,
}: {
  localPath: string;
  maxBytes: number;
  loadingTitle: string;
  errorTitle: string;
  render: FilePreviewRenderer;
  bodyClassName?: string;
  /**
   * CSS selector matching one element per page inside the rendered body. When
   * set, a floating pager tracks and jumps between those pages.
   */
  pageSelector?: string;
  pageLabel?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; revision: number }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const revisionRef = useRef(0);

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;
    if (!localPath) {
      setState({ status: "error", message: "This file can't be previewed." });
      return;
    }

    const controller = new AbortController();
    let dispose: PreviewRenderCleanup;
    body.replaceChildren();
    styles.replaceChildren();
    setState({ status: "loading" });

    void readPreviewBytes(localPath, maxBytes, controller.signal)
      .then((bytes) => render(bytes, body, styles, controller.signal))
      .then((nextDispose) => {
        if (controller.signal.aborted) {
          nextDispose?.();
          return;
        }
        dispose = nextDispose;
        revisionRef.current += 1;
        setState({ status: "ready", revision: revisionRef.current });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortReason(reason)) return;
        body.replaceChildren();
        styles.replaceChildren();
        setState({ status: "error", message: previewErrorMessage(reason) });
      });

    return () => {
      controller.abort();
      dispose?.();
      body.replaceChildren();
      styles.replaceChildren();
    };
  }, [localPath, maxBytes, render]);

  const revision = state.status === "ready" ? state.revision : -1;
  const pager = usePagedScroll(
    scrollRef,
    pageSelector ?? "[data-preview-page]",
    revision,
  );

  return (
    <PreviewPane>
      <div
        ref={scrollRef}
        className="relative min-h-0 w-full flex-1 overflow-auto"
      >
        <div ref={styleRef} aria-hidden="true" className="hidden" />
        <div
          ref={bodyRef}
          className={cn(
            "min-h-full transition-opacity",
            state.status === "ready" ? "opacity-100" : "opacity-0",
            bodyClassName,
          )}
        />
      </div>
      {state.status === "loading" ? (
        <div className="absolute inset-0 flex">
          <PreviewLoading title={loadingTitle} />
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="absolute inset-0 flex">
          <PreviewError title={errorTitle} description={state.message} />
        </div>
      ) : null}
      {pageSelector && state.status === "ready" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-7 flex justify-center">
          <PreviewPager
            page={pager.page}
            pageCount={pager.pageCount}
            onChange={pager.goToPage}
            label={pageLabel}
          />
        </div>
      ) : null}
    </PreviewPane>
  );
}

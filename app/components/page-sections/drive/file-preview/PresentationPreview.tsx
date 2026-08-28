"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { MAX_PRESENTATION_PREVIEW_BYTES } from "@/app/lib/utils/filePreviewType";
import { cn } from "@/lib/utils";

import PreviewPager from "./PreviewPager";
import { PreviewEmpty, PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewPane } from "./PreviewSurface";
import { abortError, usePreviewResource } from "./usePreviewResource";

/**
 * Every slide is a live SVG in the filmstrip as well as the main view, so a
 * deck is bounded before anything is rendered. 300 slides is far beyond any
 * real deck and still finite for a hostile one.
 */
const MAX_PREVIEW_SLIDES = 300;
const SAFE_LINK = /^(?:https?:|mailto:)/i;

/**
 * pptx-viewer renders slide text into `<foreignObject>` HTML, which inherits
 * the page's styles. Tailwind's preflight (`line-height: 1.5`, the app font,
 * the theme text colour) makes every text box taller than PowerPoint laid it
 * out and clips it, so each slide restores browser defaults for its subtree.
 */
const SLIDE_RESET_CLASS =
  "text-black [line-height:normal] [font-family:Arial,Helvetica,sans-serif] [&_p]:m-0 [&_a]:cursor-pointer";

interface PresentationPreviewData {
  slideCount: number;
  truncated: boolean;
  /** Slide width / height, so the stage keeps the deck's own aspect. */
  aspectRatio: number;
  notes: string[];
  renderSlide: (index: number, container: HTMLElement) => void;
  dispose: () => void;
}

const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "style",
  "template",
  "frame",
  "frameset",
  "applet",
  "video",
  "audio",
]);
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "srcdoc",
]);

/**
 * Scrubs the slide DOM the renderer just built.
 *
 * pptx-viewer composes most of a slide with `createElement`, but its table
 * path goes through `innerHTML`, so file-controlled markup can reach the DOM.
 * This is defence in depth for that one sink: forbidden elements are removed,
 * event handlers stripped, and only http(s)/mailto links stay clickable.
 */
function scrubRenderedSlide(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_TAGS.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
      } else if (
        URL_ATTRIBUTES.has(name) &&
        (value.startsWith("javascript:") ||
          value.startsWith("vbscript:") ||
          name === "srcdoc")
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  for (const anchor of Array.from(root.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href") ?? "";
    if (!SAFE_LINK.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
}

/**
 * Font names come straight from the file and the renderer interpolates them
 * into `style="…"` strings, so anything that could break out of a CSS string
 * is stripped before a slide is rendered.
 */
function scrubFontNames(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const entry of value.values()) scrubFontNames(entry, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) scrubFontNames(entry, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (
      (key === "fontFamily" || key === "font" || key === "major" || key === "minor") &&
      typeof entry === "string"
    ) {
      record[key] = entry.replace(/[^\w\s.-]/g, "");
    } else if (entry && typeof entry === "object") {
      scrubFontNames(entry, seen);
    }
  }
}

/**
 * Office fonts ship on none of the three platforms by default (and on Linux
 * almost never), so every run gets a metric-compatible substitute and text
 * wraps close to the way PowerPoint wrapped it instead of overflowing.
 */
const METRIC_FALLBACKS: Record<string, string> = {
  calibri: "Carlito",
  cambria: "Caladea",
  arial: '"Liberation Sans"',
  helvetica: '"Liberation Sans"',
  "times new roman": '"Liberation Serif"',
  "courier new": '"Liberation Mono"',
  georgia: "Gelasio",
};

function withFontFallbacks(family: string): string {
  const primary = family.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!primary) return family;
  const lower = primary.toLowerCase();
  const mono = /courier|mono|consolas/.test(lower);
  const serif =
    !mono &&
    !/sans/.test(lower) &&
    /times|georgia|cambria|garamond|antiqua|palatino|serif/.test(lower);
  const generic = mono
    ? '"Liberation Mono", "Courier New", monospace'
    : serif
      ? '"Liberation Serif", "Times New Roman", serif'
      : '"Liberation Sans", Arial, Helvetica, sans-serif';
  return [`"${primary}"`, METRIC_FALLBACKS[lower], generic].filter(Boolean).join(", ");
}

function applyFontFallbacks(root: HTMLElement): void {
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>("[style*='font-family']"),
  )) {
    if (element.style.fontFamily) {
      element.style.fontFamily = withFontFallbacks(element.style.fontFamily);
    }
  }
}

async function parsePresentation(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<PresentationPreviewData> {
  // Loaded on demand — the renderer and its zip reader stay out of the main
  // bundle until someone opens a deck.
  const { loadPresentation, renderSlideToElement } = await import("pptx-viewer");
  if (signal.aborted) throw abortError();

  let presentation: Awaited<ReturnType<typeof loadPresentation>>;
  try {
    presentation = await loadPresentation(bytes);
  } catch {
    throw new Error("This PowerPoint file could not be opened.");
  }
  if (signal.aborted) {
    presentation.cleanup();
    throw abortError();
  }
  scrubFontNames(presentation);

  const { width, height } = presentation.slideSize;
  const slideCount = Math.min(presentation.slides.length, MAX_PREVIEW_SLIDES);
  return {
    slideCount,
    truncated: presentation.slides.length > MAX_PREVIEW_SLIDES,
    aspectRatio: width > 0 && height > 0 ? width / height : 16 / 9,
    notes: presentation.slides
      .slice(0, slideCount)
      .map((slide) => slide.notes?.trim() ?? ""),
    renderSlide(index, container) {
      renderSlideToElement(presentation, index, container);
      const svg = container.querySelector("svg");
      if (svg) {
        // The library sizes the SVG to the container at render time; letting
        // the viewBox scale it instead keeps slides following the viewer as
        // the window resizes.
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.style.display = "block";
      }
      scrubRenderedSlide(container);
      applyFontFallbacks(container);
    },
    dispose: () => presentation.cleanup(),
  };
}

/** Renders one slide into a box that keeps the deck's aspect ratio. */
function SlideCanvas({
  data,
  index,
  lazy = false,
  className,
  style,
}: {
  data: PresentationPreviewData;
  index: number;
  /** Defer rendering until the box scrolls near the filmstrip's viewport. */
  lazy?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!lazy);

  useEffect(() => {
    const element = ref.current;
    if (!element || !lazy) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: element.closest("[data-slide-scroller]"), rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !visible) return;
    try {
      data.renderSlide(index, element);
    } catch {
      element.replaceChildren();
    }
    // Always clear on the way out: the slide's SVG is not React-owned, so
    // nothing else would remove it when the deck or the index changes.
    return () => element.replaceChildren();
  }, [data, index, visible]);

  return (
    <div
      ref={ref}
      style={{ aspectRatio: `${data.aspectRatio}`, ...style }}
      className={cn("overflow-hidden bg-white", SLIDE_RESET_CLASS, className)}
    />
  );
}

function disposePresentation(data: PresentationPreviewData): void {
  data.dispose();
}

/**
 * PPTX rendered as actual slides: a filmstrip of numbered thumbnails, the
 * current slide on a stage at the deck's own aspect ratio, a "n / total"
 * pager, keyboard navigation and the speaker notes.
 */
export default function PresentationPreview({
  localPath,
}: {
  localPath: string;
}) {
  const parse = useCallback(parsePresentation, []);
  const state = usePreviewResource(
    localPath,
    MAX_PRESENTATION_PREVIEW_BYTES,
    parse,
    { dispose: disposePresentation },
  );
  const [current, setCurrent] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const data = state.status === "ready" ? state.data : null;

  useEffect(() => {
    setCurrent(0);
  }, [data]);

  // Keep the active thumbnail in view when navigating with the pager or keys.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-slide-index="${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (state.status === "loading") {
    return <PreviewLoading title="Opening presentation…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this presentation"
        description={state.message}
      />
    );
  }
  if (!data || data.slideCount === 0) {
    return <PreviewEmpty title="This presentation has no slides" />;
  }

  const goTo = (index: number) =>
    setCurrent(Math.max(0, Math.min(data.slideCount - 1, index)));
  const notes = data.notes[current];

  return (
    <PreviewPane>
      <div
        tabIndex={0}
        onKeyDown={(event) => {
          // Up/Down and PageUp/PageDown move slides. Left/Right are left alone
          // so the viewer's own prev/next file navigation still works.
          const handlers: Record<string, () => void> = {
            ArrowUp: () => goTo(current - 1),
            PageUp: () => goTo(current - 1),
            ArrowDown: () => goTo(current + 1),
            PageDown: () => goTo(current + 1),
            Home: () => goTo(0),
            End: () => goTo(data.slideCount - 1),
          };
          const handler = handlers[event.key];
          if (!handler) return;
          event.preventDefault();
          event.stopPropagation();
          handler();
        }}
        className="flex min-h-0 flex-1 gap-4 outline-none"
      >
        <div
          ref={stripRef}
          data-slide-scroller
          role="tablist"
          aria-label="Slides"
          className="hidden w-44 shrink-0 flex-col gap-3 overflow-y-auto px-1 pb-2 pt-1 lg:flex"
        >
          {Array.from({ length: data.slideCount }, (_, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === current}
              aria-label={`Slide ${index + 1}`}
              data-slide-index={index}
              onClick={() => goTo(index)}
              className="flex shrink-0 scroll-my-1 items-start gap-2 text-left"
            >
              <span
                className={cn(
                  "w-4 shrink-0 pt-0.5 text-right text-[11px] font-medium tabular-nums",
                  index === current
                    ? "text-primary-50"
                    : "text-grey-50 dark:text-grey-light-300",
                )}
              >
                {index + 1}
              </span>
              <SlideCanvas
                data={data}
                index={index}
                lazy
                className={cn(
                  "w-full rounded-[3px] border border-grey-dark-100 shadow-[0_1px_3px_rgba(0,0,0,0.12)] dark:border-black-300",
                  index === current && "border-primary-50 ring-2 ring-primary-50",
                )}
              />
            </button>
          ))}
          {data.truncated ? (
            <p className="shrink-0 text-center text-[11px] text-grey-50 dark:text-grey-light-300">
              First {MAX_PREVIEW_SLIDES} slides only.
            </p>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* `items-start` + the filmstrip's own `pt-1`: the current slide's
              top edge must line up with thumbnail 1's top edge. Centring the
              stage instead only looked right for a deck long enough to fill
              the filmstrip's height — a short deck floated the slide down to
              the middle while the thumbnails stayed at the top. `containerType:
              size` makes `cqh` the content-box height, so the padding is
              already excluded from the slide's own sizing. */}
          <div
            style={{ containerType: "size" }}
            className="relative flex min-h-0 flex-1 items-start justify-center pt-1"
          >
            {/* Shrink-wraps the slide so the pager sits at the slide's bottom
                edge rather than floating at the bottom of the empty stage. */}
            <div
              className="relative"
              style={{ width: `min(100%, calc(100cqh * ${data.aspectRatio}))` }}
            >
              <SlideCanvas
                key={current}
                data={data}
                index={current}
                className="w-full rounded-[4px] shadow-[0_14px_31px_rgba(0,0,0,0.12)] animate-scale-in-95-0.4"
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                <PreviewPager
                  page={current}
                  pageCount={data.slideCount}
                  onChange={goTo}
                  label="slide"
                />
              </div>
            </div>
          </div>
          {notes ? (
            <div className="max-h-32 shrink-0 overflow-y-auto rounded-[8px] border border-grey-dark-100 bg-white px-4 py-3 text-xs leading-5 text-grey-30 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-light-300">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-grey-50 dark:text-grey-light-300">
                Speaker notes
              </p>
              <p className="whitespace-pre-wrap">{notes}</p>
            </div>
          ) : null}
        </div>
      </div>
    </PreviewPane>
  );
}

"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fitMiddle, identityKind, type IdentityKind } from "@/lib/utils/fitMiddle";

/*
 * One line of an identity (an address, a name, an email) shortened in the
 * middle to the width it is given, never at the end.
 *
 * Put it where CSS `truncate` would go, in a flex row with `min-w-0` or in a
 * block. It asks for its full text's width, shrinks like any flex item, then
 * measures the width it got and shows the longest `start…end` that fits,
 * again on every resize and once the webfonts have loaded.
 *
 * How it stays still:
 * - An invisible copy of the full text sits in the same grid cell as the
 *   line, drawn by CSS (`content: attr(data-text)`) so it is not text in the
 *   page. It keeps the element's natural width at the full text's, so a row
 *   that grows gives the text its room back (a shortened line alone would
 *   have shrunk the element to itself, for good). Sharing the line's cell,
 *   it adds no height and no second baseline.
 * - The fit runs in a layout effect, before paint, so the full text is never
 *   seen spilling and then snapping short.
 * - The full text stays in the `title` and is what a screen reader reads:
 *   while the line is shortened it is hidden from them and a visually hidden
 *   copy of the full text is read instead.
 */

/** Guards against canvas and layout rounding a hair apart. */
const SAFETY_PX = 1;

let canvas: HTMLCanvasElement | null = null;

/** A measurer for `el`'s font, with the canvas it shares with every line. */
function measurerFor(el: Element): ((text: string) => number) | null {
  if (!canvas) canvas = document.createElement("canvas");
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const s = window.getComputedStyle(el);
  const font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  const spacing = parseFloat(s.letterSpacing);
  const letterSpacing = Number.isFinite(spacing) ? spacing : 0;
  const context = ctx;
  return (text: string) => {
    context.font = font;
    // Letter spacing (tracking) widens every character, the ellipsis too.
    return context.measureText(text).width + letterSpacing * [...text].length;
  };
}

export interface MiddleTruncateProps {
  /** The full value. Always what the title and a screen reader get. */
  text: string;
  /** Where the cut may land; worked out from the text when omitted. */
  kind?: IdentityKind;
  className?: string;
  /**
   * The native hover text. The full value by default; `null` for none, when
   * a tooltip around it already says more.
   */
  title?: string | null;
  /** Hide the full value from screen readers too, when a label nearby says it. */
  srText?: boolean;
}

export default function MiddleTruncate({
  text,
  kind,
  className,
  title,
  srText = true,
}: MiddleTruncateProps) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  const fit = useCallback(() => {
    const box = boxRef.current;
    const ghost = ghostRef.current;
    if (!box || !ghost) return;
    const width = box.clientWidth;
    // Not laid out (hidden, or a test DOM): leave the full text to the clip.
    if (width <= 0) {
      setShown(text);
      return;
    }
    // Layout's own answer first: the full text fits, so nothing is cut.
    if (ghost.scrollWidth <= width) {
      setShown(text);
      return;
    }
    const measure = measurerFor(box);
    if (!measure) {
      setShown(text);
      return;
    }
    setShown(fitMiddle(text, width - SAFETY_PX, measure, kind ?? identityKind(text)));
  }, [text, kind]);

  useLayoutEffect(() => {
    fit();
    const box = boxRef.current;
    let cancelled = false;
    // A font swap changes widths without resizing anything.
    if (typeof document !== "undefined" && "fonts" in document) {
      document.fonts.ready.then(() => !cancelled && fit()).catch(() => {});
    }
    if (!box || typeof ResizeObserver === "undefined") {
      return () => {
        cancelled = true;
      };
    }
    const ro = new ResizeObserver(() => fit());
    ro.observe(box);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [fit]);

  const shortened = shown !== text;
  return (
    <span
      ref={boxRef}
      data-middle-truncate=""
      data-shortened={shortened || undefined}
      title={title === null ? undefined : (title ?? text)}
      className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden whitespace-nowrap", className)}
    >
      <span aria-hidden={shortened || !srText ? true : undefined} className="col-start-1 row-start-1 min-w-0">
        {shown}
      </span>
      {/* Same cell, invisible: keeps the natural width at the full text's. */}
      <span
        ref={ghostRef}
        aria-hidden="true"
        data-text={text}
        className="invisible col-start-1 row-start-1 min-w-0 after:content-[attr(data-text)]"
      />
      {shortened && srText ? <span className="sr-only">{text}</span> : null}
    </span>
  );
}

"use client";

import { useRef, useEffect, FC } from "react";
import { cn } from "@/lib/utils";

interface MiddleTruncatedNameProps {
  /** The full, untruncated filename */
  name: string;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Shared off-screen Canvas for pixel-accurate text measurement       */
/* ------------------------------------------------------------------ */
let _canvas: HTMLCanvasElement | null = null;

function getTextWidth(text: string, font: string): number {
  if (!_canvas) _canvas = document.createElement("canvas");
  const ctx = _canvas.getContext("2d");
  if (!ctx) return text.length * 8; // coarse fallback
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Read the resolved CSS font shorthand from a live DOM element. */
function resolveFont(el: Element): string {
  const s = window.getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
}

/* ------------------------------------------------------------------ */
/*  Pure middle-truncation logic                                       */
/* ------------------------------------------------------------------ */
const ELLIPSIS = "\u2026"; // …

function middleTruncate(
  name: string,
  maxWidth: number,
  font: string,
): string {
  if (getTextWidth(name, font) <= maxWidth) return name;

  const dotIdx = name.lastIndexOf(".");
  let base: string, ext: string;
  if (dotIdx > 0 && dotIdx < name.length - 1) {
    base = name.slice(0, dotIdx);
    ext = name.slice(dotIdx);
  } else {
    base = name;
    ext = "";
  }

  const minimum = `${base.charAt(0)}${ELLIPSIS}${ext}`;
  if (getTextWidth(minimum, font) > maxWidth) return minimum;

  let lo = 2,
    hi = base.length,
    best = minimum;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const startLen = Math.ceil(mid * 0.6);
    const endLen = mid - startLen;
    const candidate =
      base.slice(0, startLen) +
      ELLIPSIS +
      (endLen > 0 ? base.slice(-endLen) : "") +
      ext;

    if (getTextWidth(candidate, font) <= maxWidth) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

/* ------------------------------------------------------------------ */
/*  Component — direct DOM updates, zero React re-renders on resize    */
/* ------------------------------------------------------------------ */

const MiddleTruncatedName: FC<MiddleTruncatedNameProps> = ({
  name,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  // Cache the resolved font so we don't call getComputedStyle on every frame
  const fontRef = useRef<string>("");

  useEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    // Resolve font once (it won't change during the lifetime of this element)
    fontRef.current = resolveFont(container);

    /** Synchronously update the DOM text — no setState, no re-render */
    const update = () => {
      const w = container.clientWidth;
      if (w <= 0) return;
      const truncated = middleTruncate(name, w, fontRef.current);
      // Only touch the DOM if the value actually changed
      if (textEl.textContent !== truncated) {
        textEl.textContent = truncated;
      }
    };

    // Initial paint
    update();

    const ro = new ResizeObserver(() => {
      // ResizeObserver already fires at the right time in the rendering
      // pipeline — just update synchronously, no RAF needed
      update();
    });
    ro.observe(container);

    return () => ro.disconnect();
  }, [name]);

  return (
    <div
      ref={containerRef}
      className={cn("flex-1 min-w-0 overflow-hidden text-left", className)}
    >
      <span ref={textRef} className="whitespace-nowrap block" title={name}>
        {name}
      </span>
    </div>
  );
};

export default MiddleTruncatedName;

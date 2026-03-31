"use client";

import { useRef, useEffect, useState, FC, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

interface MiddleTruncatedNameProps {
  /** The full, untruncated filename */
  name: string;
  className?: string;
  /** Classes applied directly to the inner text span (e.g. hover styles
   *  like underline/color that must target the text element itself rather
   *  than a flex wrapper). */
  textClassName?: string;
  /** Optional inline content rendered immediately after the name (e.g. a status icon).
   *  Its width is subtracted from the available space before truncation is computed,
   *  so the icon always stays visible next to the text. */
  suffix?: ReactNode;
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
  textClassName,
  suffix,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const suffixRef = useRef<HTMLSpanElement>(null);
  const fontRef = useRef<string>("");
  const isTruncatedRef = useRef(false);
  // Force a single re-render after first measurement to enable/disable tooltip
  const [, setTick] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    fontRef.current = resolveFont(container);

    const update = () => {
      const w = container.clientWidth;
      if (w <= 0) return;
      // Reserve space for the suffix (icon) so truncation doesn't overlap it
      const suffixW = suffixRef.current?.offsetWidth ?? 0;
      const available = w - suffixW;
      const truncated = middleTruncate(name, available, fontRef.current);
      const wasTruncated = truncated !== name;
      if (textEl.textContent !== truncated) {
        textEl.textContent = truncated;
      }
      if (isTruncatedRef.current !== wasTruncated) {
        isTruncatedRef.current = wasTruncated;
        setTick((t) => t + 1);
      }
    };

    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(container);

    return () => ro.disconnect();
  }, [name]);

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <div
          ref={containerRef}
          className={cn("flex-1 min-w-0 overflow-hidden text-left", className)}
        >
          <span className="whitespace-nowrap inline-flex items-center">
            <Tooltip.Trigger asChild>
              <span ref={textRef} className={textClassName}>{name}</span>
            </Tooltip.Trigger>
            {suffix && (
              <span ref={suffixRef} className="inline-flex flex-shrink-0">
                {suffix}
              </span>
            )}
          </span>
        </div>
        {isTruncatedRef.current && (
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              className="z-[10000] bg-white border border-grey-80 rounded-[0.5rem] px-3 py-2 text-sm font-medium text-grey-40 shadow-lg max-w-[25rem] w-max whitespace-normal break-all transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
              sideOffset={4}
            >
              {name}
              <Tooltip.Arrow className="fill-white" />
            </Tooltip.Content>
          </Tooltip.Portal>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default MiddleTruncatedName;

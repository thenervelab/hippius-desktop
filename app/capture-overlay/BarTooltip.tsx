"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "./tooltipPlacement";

/**
 * The capture bar's own tooltip, in place of native `title` tooltips: macOS
 * draws those in a window below the overlay (which sits at the screen saver
 * level), so they showed behind the toolbar, and only after the system's
 * delay. This one is part of the page, so it is above the bar by
 * construction, and it shows at once on hover and on keyboard focus.
 *
 * One tooltip for the whole bar: `useBarTooltip` hands each button its
 * handlers (`tipProps`) and renders the tooltip for whichever button is
 * pointed at or focused. Its text is the button's name, plus a second line
 * for why a choice is unavailable or which key does it.
 */

export interface TipText {
  /** What the button does, as its name says it. */
  label: string;
  /** A second line: why it is unavailable, or the key that does it. */
  detail?: string;
}

const TIP_ID = "capture-bar-tip";

/**
 * Rendered into `document.body`: the overlay's bar column is placed with a
 * transform and its glass with a backdrop blur, and either would make a
 * `fixed` tooltip inside it relative to the bar instead of the window. In
 * Wayland's panel the body is the panel's window, so the same holds there.
 */
export function useBarTooltip() {
  const [shown, setShown] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  // Each button's current text, read when the tooltip draws, so a reason
  // that changes while it shows is shown as it is now.
  const texts = useRef(new Map<string, TipText>());
  const tipRef = useRef<HTMLDivElement | null>(null);

  const show = useCallback((key: string, anchor: HTMLElement) => setShown({ key, anchor }), []);
  const hide = useCallback((key: string) => setShown((s) => (s && s.key === key ? null : s)), []);

  /** The handlers and description for one button. */
  const tipProps = (key: string, text: TipText) => {
    texts.current.set(key, text);
    return {
      // Both event families: WebKitGTK sends no pointer events for the mouse.
      onPointerEnter: (e: React.PointerEvent<HTMLElement>) => show(key, e.currentTarget),
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(key, e.currentTarget),
      onPointerLeave: () => hide(key),
      onMouseLeave: () => hide(key),
      onFocus: (e: React.FocusEvent<HTMLElement>) => show(key, e.currentTarget),
      onBlur: () => hide(key),
      "aria-describedby": shown?.key === key ? TIP_ID : undefined,
    };
  };

  const text = shown ? texts.current.get(shown.key) : undefined;

  // Placed before paint, from the button's box and the tooltip's own size,
  // so it never shows a frame in the wrong place. A button that went away
  // (the bar changed under the pointer) takes its tooltip with it.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) return;
    if (!shown.anchor.isConnected) {
      setShown(null);
      return;
    }
    const a = shown.anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const place = placeTooltip(
      { left: a.left, top: a.top, width: a.width, height: a.height },
      { width: t.width, height: t.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    tip.style.left = `${place.left}px`;
    tip.style.top = `${place.top}px`;
    tip.dataset.side = place.side;
    tip.style.visibility = "visible";
    // Again when the text changes, since the tooltip's size does.
  }, [shown, text?.label, text?.detail]);

  const tooltip =
    shown && text ? (
      <div
        ref={tipRef}
        id={TIP_ID}
        role="tooltip"
        data-testid="capture-bar-tooltip"
        // Hidden until placed (the layout effect above, before paint).
        style={{ visibility: "hidden" }}
        className="pointer-events-none fixed left-0 top-0 z-[2147483647] max-w-[280px] rounded-[8px] border border-white/10 bg-[#1c1d21]/95 px-2.5 py-1.5 text-left text-[12px] leading-4 text-white shadow-[0_2px_8px_rgba(0,0,0,0.4)] backdrop-blur-xl"
      >
        <span className="block font-medium">{text.label}</span>
        {text.detail && <span className="mt-0.5 block text-white/75">{text.detail}</span>}
      </div>
    ) : null;

  return {
    tipProps,
    tooltip: tooltip && typeof document !== "undefined" ? createPortal(tooltip, document.body) : null,
  };
}

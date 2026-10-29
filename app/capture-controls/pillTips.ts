"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type RefObject,
} from "react";
import { onTauriEvent } from "@/app/lib/utils/tauriListeners";
import {
  PILL_POINTER_EVENT,
  setCapturePillTip,
  type CapturePillTipRequest,
  type CaptureWindowPoint,
} from "@/app/lib/tauri/capture";
import { boxFrom, markedAt } from "@/app/lib/capture/rustHover";
import { focusFromKeyboard } from "@/app/capture-overlay/BarTooltip";

/**
 * The recording pill's tooltips.
 *
 * The pill is never the key window (the app being recorded keeps the
 * keyboard), so on macOS its webview gets no hover at all: no `:hover`, no
 * pointer events, and native `title` tooltips never show. Rust watches the
 * pointer instead and sends where it is on the pill's row
 * (`capture_pill_pointer`); this finds the button under that point, lights
 * it (`data-hover`) and asks Rust to show its tooltip. The tooltip is drawn
 * in a window of its own over the pill (`capture-pill-tip`): the pill's
 * window is only as tall as the pill, so a tooltip above a button would be
 * cut off in it.
 *
 * Keyboard focus shows the tooltip too, only when it came from the keyboard
 * (`:focus-visible`). The pointer wins over focus while it is on a button.
 * Nothing is sent where Rust says the pill has no tooltips (`tips` false:
 * Linux, where the pill and so a tooltip would be filmed).
 */

/** Marks a pill button that has a tooltip; its value is the button's key. */
export const PILL_TIP_ATTR = "data-pill-tip";

export interface PillTipText {
  /** What the button does: the same words as its `aria-label`. */
  label: string;
  /** A second line: the key that does it. */
  detail?: string;
}

/**
 * What to ask Rust for: the button `key` names in `row` (the pill's row,
 * which Rust's point and the tooltip's box are both measured from), with its
 * text, or null when there is none to show.
 */
export function pillTipRequest(
  row: HTMLElement | null,
  key: string | null,
  text: PillTipText | undefined,
  fromPointer: boolean,
): CapturePillTipRequest | null {
  if (!row || !key || !text) return null;
  const button = Array.from(
    row.querySelectorAll(`[${PILL_TIP_ATTR}]`),
  ).find((el) => el.getAttribute(PILL_TIP_ATTR) === key);
  if (!button) return null;
  const anchor = boxFrom(
    button.getBoundingClientRect(),
    row.getBoundingClientRect(),
  );
  return {
    label: text.label,
    ...(text.detail ? { detail: text.detail } : {}),
    anchor,
    fromPointer,
  };
}

export function usePillTips(
  enabled: boolean,
  rowRef: RefObject<HTMLElement | null>,
) {
  const [point, setPoint] = useState<CaptureWindowPoint | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // Each button's text as of this render, so a label that changes under a
  // still pointer (Pause becomes Resume) is sent again.
  const texts = useRef(new Map<string, PillTipText>());
  const sent = useRef("null");

  useEffect(() => {
    if (!enabled) return;
    const unlisten = onTauriEvent<CaptureWindowPoint | null>(
      PILL_POINTER_EVENT,
      (e) => setPoint(e.payload),
    );
    return () => {
      unlisten();
    };
  }, [enabled]);

  // Which button is under the pointer, read again after every render: the
  // buttons under a pointer that does not move change too (the controls
  // unfold, a question takes the pill's place).
  // After every render on purpose; it sets state only when the element
  // under the pointer changed, so it settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const row = rowRef.current;
    const el =
      enabled && row
        ? markedAt(point, row.getBoundingClientRect(), PILL_TIP_ATTR)
        : null;
    const key = el?.getAttribute(PILL_TIP_ATTR) ?? null;
    if (key !== hovered) setHovered(key);
  });

  // Rust is told only of a change: another button, other words, or the
  // button moved.
  useEffect(() => {
    const key = enabled ? (hovered ?? focused) : null;
    const request = pillTipRequest(
      rowRef.current,
      key,
      key ? texts.current.get(key) : undefined,
      hovered !== null,
    );
    const json = JSON.stringify(request);
    if (json === sent.current) return;
    sent.current = json;
    void setCapturePillTip(request).catch(() => undefined);
  });

  // The page going (the recording ended) takes its tooltip with it.
  useEffect(
    () => () => {
      if (sent.current !== "null")
        void setCapturePillTip(null).catch(() => undefined);
    },
    [],
  );

  /** The tooltip's marks and focus handlers for one button. */
  const tipProps = (key: string, text: PillTipText) => {
    texts.current.set(key, text);
    return {
      [PILL_TIP_ATTR]: key,
      // Lit like `:hover`, which never happens in a window that is not key.
      "data-hover": hovered === key ? "true" : undefined,
      onFocus: (e: FocusEvent<Element>) => {
        if (focusFromKeyboard(e.currentTarget)) setFocused(key);
      },
      onBlur: () => setFocused((f) => (f === key ? null : f)),
    } as const;
  };

  return { tipProps, hovered };
}

"use client";

// Draws only the rows of a long list that are in, or near, the visible part
// of its scrolling container. A group's full view can hold 100+ rows, each
// with a role select, a menu and their dialogs; mounting all of them makes
// the panel slow to open and to scroll.
//
// Rows differ in height (a link row carries a usage bar and a link field, a
// refused change adds a line under its row), so each drawn row is measured
// and remembered by its key; rows not measured yet use the estimate. The
// list keeps its full height, so the scrollbar reads true.
//
// Presentation only: which rows exist and in what order is the caller's.

import { useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";

/** How far past the visible edge rows are still drawn, in px. */
const OVERSCAN_PX = 480;
/** The visible height assumed before the container can be measured (tests, first frame). */
const FALLBACK_VIEWPORT_PX = 640;

export type WindowedRow = { index: number; key: string; start: number };

export function useWindowedRows(params: {
  keys: readonly string[];
  /** A row's height before it is measured. */
  estimate: number;
  /** The element that scrolls. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The list itself, somewhere inside the scrolling element. */
  listRef: RefObject<HTMLElement | null>;
}): { rows: WindowedRow[]; totalHeight: number; measure: (el: HTMLElement | null) => (() => void) | undefined } {
  const { keys, estimate, scrollRef, listRef } = params;
  const heights = useRef(new Map<string, number>());
  const [measured, bump] = useReducer((n: number) => n + 1, 0);
  const [view, setView] = useState({ top: 0, height: 0 });

  // Where the list sits in the scrolled content, and how much of it shows.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const update = () => {
      const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const top = scroller.scrollTop - listTop;
      const height = scroller.clientHeight;
      setView((v) => (v.top === top && v.height === height ? v : { top, height }));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [scrollRef, listRef]);

  // One observer for every drawn row: a row that grows (a refusal under it,
  // a folder tag that wraps) moves the rows after it.
  const rowObserver = useMemo(() => {
    if (typeof ResizeObserver === "undefined") return null;
    return new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.rowKey;
        const h = el.offsetHeight;
        if (key && h > 0 && heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) bump();
    });
  }, []);
  useLayoutEffect(() => () => rowObserver?.disconnect(), [rowObserver]);

  const measure = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !rowObserver) return undefined;
      rowObserver.observe(el);
      return () => rowObserver.unobserve(el);
    },
    [rowObserver],
  );

  return useMemo(() => {
    const starts: number[] = new Array(keys.length);
    let offset = 0;
    for (let i = 0; i < keys.length; i++) {
      starts[i] = offset;
      offset += heights.current.get(keys[i]) ?? estimate;
    }
    const viewport = view.height > 0 ? view.height : FALLBACK_VIEWPORT_PX;
    const from = view.top - OVERSCAN_PX;
    const to = view.top + viewport + OVERSCAN_PX;
    const rows: WindowedRow[] = [];
    for (let i = 0; i < keys.length; i++) {
      const start = starts[i];
      const end = start + (heights.current.get(keys[i]) ?? estimate);
      if (end < from) continue;
      if (start > to) break;
      rows.push({ index: i, key: keys[i], start });
    }
    return { rows, totalHeight: offset, measure };
    // `measured` is the signal that `heights` changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, estimate, view, measured, measure]);
}

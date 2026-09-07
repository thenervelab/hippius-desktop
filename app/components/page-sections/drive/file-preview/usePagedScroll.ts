"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Tracks which "page" (a Word page, a slide) is most visible inside a scroll
 * container, and lets callers jump to one.
 *
 * Pages are found with a CSS selector rather than being passed in, because the
 * DOM they live in is built by a third-party renderer (docx-preview) that React
 * never sees. `revision` is what tells the hook that DOM was replaced.
 */
export function usePagedScroll(
  containerRef: RefObject<HTMLElement | null>,
  pageSelector: string,
  /** Bump when the container's children change (a new file rendered). */
  revision: unknown,
): { page: number; pageCount: number; goToPage: (index: number) => void } {
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pages = Array.from(
      container.querySelectorAll<HTMLElement>(pageSelector),
    );
    setPageCount(pages.length);
    setPage(0);
    if (pages.length === 0) return;
    // jsdom and the odd WebView build ship without IntersectionObserver; the
    // pager degrades to a static "1 / n" rather than throwing on mount.
    if (typeof IntersectionObserver === "undefined") return;

    const visibility = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibility.set(entry.target, entry.intersectionRatio);
        }
        let best = -1;
        let bestRatio = 0;
        pages.forEach((element, index) => {
          const ratio = visibility.get(element) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = index;
          }
        });
        if (best >= 0) setPage(best);
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const element of pages) observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, pageSelector, revision]);

  const goToPage = useCallback(
    (index: number) => {
      const container = containerRef.current;
      if (!container) return;
      const pages = container.querySelectorAll<HTMLElement>(pageSelector);
      const target = pages[Math.max(0, Math.min(pages.length - 1, index))];
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [containerRef, pageSelector],
  );

  return { page, pageCount, goToPage };
}

import { useEffect, useRef, type RefObject } from "react";

/**
 * Scroll-sentinel wiring for infinite scroll, shared by the files table and
 * the card view.
 *
 * `loadMore` fires only on a genuine ENTER transition — the sentinel coming
 * into view from outside — never merely because the sentinel is (still)
 * visible when the observer re-attaches. The distinction is the whole point:
 * the observer re-attaches whenever `loadMore`'s identity changes (every
 * appended page), and IntersectionObserver reports current state on attach.
 * With few visible rows (an active filter matching 3 files in a huge remote
 * folder) the sentinel never leaves the viewport, so "visible on re-attach"
 * chain-fired a fetch for EVERY completed page — a skeleton strip flashing in
 * a loop while the app quietly paged through the entire folder server-side.
 *
 * The previous-intersection state lives in a ref that survives re-attaches;
 * normal deep scrolling still pages naturally because each 50-row append
 * pushes the sentinel well below the viewport (a real leave), and the user's
 * scroll brings it back in (a real enter).
 */
export function useLoadMoreSentinel(
  sentinelRef: RefObject<HTMLElement | null>,
  hasMore: boolean,
  loadMore: () => void,
): void {
  const wasIntersectingRef = useRef(false);

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries[0].isIntersecting;
        if (isIntersecting && !wasIntersectingRef.current) {
          loadMore();
        }
        wasIntersectingRef.current = isIntersecting;
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, sentinelRef]);
}

export default useLoadMoreSentinel;

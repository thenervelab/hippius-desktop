import { useMemo, useState, useEffect, useRef, useCallback } from "react";

const INITIAL_COUNT = 50;
const LOAD_MORE_COUNT = 50;

export const useInfiniteScroll = <T>(
  data: T[],
  // Cheap, O(1) key for a row used to detect "the data source changed" and
  // reset the scroll window. Pass primitive fields only — NEVER serialize the
  // whole row. Omitting it falls back to a length-only signature (callers that
  // already call resetScroll() explicitly on source swaps don't strictly need
  // it). The previous JSON.stringify-per-sample ran on every refetch tick
  // during an active sync; this avoids that hot-path cost.
  keyFn?: (item: T) => string | number
) => {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);
  // Mirrors `visibleCount` for reads inside stable callbacks.
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
  // Armed when `loadMore` is called with NOTHING left to reveal (the window
  // already covers the whole list) — i.e. the user drove the scroll to the
  // very end and a server page is being fetched. When the next APPEND lands,
  // the window grows one page automatically so the new rows actually paint.
  // Without this the fetched page landed entirely beyond the window: nothing
  // rendered, no height changed, the sentinel never left the viewport, and —
  // since the sentinel only fires on enter transitions — pagination stalled
  // until the user jiggled the scroll. Only an explicit loadMore arms it, so
  // background prefetch appends never auto-expand the window (that would
  // re-create the fetch→render→prefetch chain at the bottom of the list).
  const pendingGrowRef = useRef(false);

  // Track data signature to reset on data source changes
  const prevDataSignatureRef = useRef<string>("");
  // Snapshot of the previous list's shape, used to tell a pure APPEND (rows
  // added at the end — remote server pagination) apart from a source swap.
  // An append must NOT reset the window: collapsing back to INITIAL_COUNT
  // mid-scroll unmounts every rendered row, drops the viewport past the end
  // of the shrunken table, and the sentinel then regrows the window one
  // LOAD_MORE_COUNT step per IntersectionObserver transition — a freeze +
  // flicker loop on every fetched page.
  const prevShapeRef = useRef<{ len: number; first: string; last: string }>({
    len: 0,
    first: "",
    last: "",
  });

  const dataSignature = useMemo(() => {
    if (data.length === 0) return "";
    const sample = (i: number) => (keyFn ? String(keyFn(data[i])) : "");
    const mid = data.length > 2 ? sample(Math.floor(data.length / 2)) : "";
    const last = data.length > 1 ? sample(data.length - 1) : "";
    return `${data.length}|${sample(0)}|${mid}|${last}`;
  }, [data, keyFn]);

  // Reset visible count when data source changes significantly
  useEffect(() => {
    const prev = prevShapeRef.current;
    // Append = the old list is still an untouched prefix of the new one.
    // Verifiable only with a keyFn; keyFn-less callers keep the old
    // reset-on-any-change behavior.
    const isAppend =
      keyFn !== undefined &&
      prev.len > 0 &&
      data.length > prev.len &&
      String(keyFn(data[0])) === prev.first &&
      String(keyFn(data[prev.len - 1])) === prev.last;
    if (
      prevDataSignatureRef.current !== "" &&
      dataSignature !== prevDataSignatureRef.current &&
      !isAppend
    ) {
      pendingGrowRef.current = false;
      setVisibleCount(INITIAL_COUNT);
    } else if (isAppend && pendingGrowRef.current) {
      // The append the end-of-list loadMore was waiting for — reveal it.
      pendingGrowRef.current = false;
      const target = data.length;
      setVisibleCount((prev) => Math.min(prev + LOAD_MORE_COUNT, target));
    }
    prevDataSignatureRef.current = dataSignature;
    prevShapeRef.current = {
      len: data.length,
      first: data.length > 0 && keyFn ? String(keyFn(data[0])) : "",
      last:
        data.length > 0 && keyFn ? String(keyFn(data[data.length - 1])) : "",
    };
  }, [dataSignature, data, keyFn]);

  const visibleData = useMemo(
    () => data.slice(0, visibleCount),
    [data, visibleCount]
  );

  const hasMore = visibleCount < data.length;

  const loadMore = useCallback(() => {
    if (visibleCountRef.current >= data.length) {
      // Nothing buffered to reveal — arm the window to grow when the page
      // currently being fetched appends (see `pendingGrowRef`).
      pendingGrowRef.current = true;
      return;
    }
    setVisibleCount((prev) => Math.min(prev + LOAD_MORE_COUNT, data.length));
  }, [data.length]);

  const resetScroll = useCallback(() => {
    pendingGrowRef.current = false;
    setVisibleCount(INITIAL_COUNT);
  }, []);

  return { visibleData, hasMore, loadMore, resetScroll };
};

export default useInfiniteScroll;

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

  // Track data signature to reset on data source changes
  const prevDataSignatureRef = useRef<string>("");

  const dataSignature = useMemo(() => {
    if (data.length === 0) return "";
    const sample = (i: number) => (keyFn ? String(keyFn(data[i])) : "");
    const mid = data.length > 2 ? sample(Math.floor(data.length / 2)) : "";
    const last = data.length > 1 ? sample(data.length - 1) : "";
    return `${data.length}|${sample(0)}|${mid}|${last}`;
  }, [data, keyFn]);

  // Reset visible count when data source changes significantly
  useEffect(() => {
    if (
      prevDataSignatureRef.current !== "" &&
      dataSignature !== prevDataSignatureRef.current
    ) {
      setVisibleCount(INITIAL_COUNT);
    }
    prevDataSignatureRef.current = dataSignature;
  }, [dataSignature]);

  const visibleData = useMemo(
    () => data.slice(0, visibleCount),
    [data, visibleCount]
  );

  const hasMore = visibleCount < data.length;

  const loadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + LOAD_MORE_COUNT, data.length));
  }, [data.length]);

  const resetScroll = useCallback(() => {
    setVisibleCount(INITIAL_COUNT);
  }, []);

  return { visibleData, hasMore, loadMore, resetScroll };
};

export default useInfiniteScroll;

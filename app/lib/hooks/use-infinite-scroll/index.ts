import { useMemo, useState, useEffect, useRef, useCallback } from "react";

const INITIAL_COUNT = 50;
const LOAD_MORE_COUNT = 50;

export const useInfiniteScroll = <T>(data: T[]) => {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);

  // Track data signature to reset on data source changes
  const prevDataSignatureRef = useRef<string>("");

  const dataSignature = useMemo(() => {
    if (data.length === 0) return "";
    const samples: unknown[] = [data[0]];
    if (data.length > 2) samples.push(data[Math.floor(data.length / 2)]);
    if (data.length > 1) samples.push(data[data.length - 1]);
    return samples
      .map((item) => JSON.stringify(item).substring(0, 50))
      .join("|");
  }, [data]);

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

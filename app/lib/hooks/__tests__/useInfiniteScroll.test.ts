import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useInfiniteScroll } from "../use-infinite-scroll";

type Row = { id: string };

const makeRows = (start: number, count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `row-${start + i}` }));

const keyFn = (r: Row) => r.id;

describe("useInfiniteScroll", () => {
  it("grows the visible window by pages via loadMore", () => {
    const data = makeRows(0, 120);
    const { result } = renderHook(() => useInfiniteScroll(data, keyFn));

    expect(result.current.visibleData).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    expect(result.current.visibleData).toHaveLength(100);

    act(() => result.current.loadMore());
    expect(result.current.visibleData).toHaveLength(120);
    expect(result.current.hasMore).toBe(false);
  });

  // The remote-pagination regression: a server page APPENDED to the list must
  // not collapse the window back to the initial page. Collapsing unmounted
  // every rendered row mid-scroll, dropped the viewport past the table's end,
  // and the sentinel then regrew the window one step per observer transition —
  // the freeze/flicker loop on every fetched remote page.
  it("keeps the scroll window when rows are appended at the end", () => {
    let data = makeRows(0, 100);
    const { result, rerender } = renderHook(
      ({ rows }) => useInfiniteScroll(rows, keyFn),
      { initialProps: { rows: data } },
    );

    act(() => result.current.loadMore());
    expect(result.current.visibleData).toHaveLength(100);

    // Server page lands: same prefix, 50 new rows at the end.
    data = [...data, ...makeRows(100, 50)];
    rerender({ rows: data });

    expect(result.current.visibleData).toHaveLength(100);
    expect(result.current.hasMore).toBe(true);
  });

  // The end-of-list stall: with the sentinel firing only on enter
  // transitions, a page fetched at the very end used to land entirely beyond
  // the render window — nothing painted, no height changed, and pagination
  // stalled until the user scrolled up and back down. A loadMore issued with
  // nothing left to reveal must instead arm the window to grow when that
  // page appends.
  it("grows the window on append when loadMore was called at the end", () => {
    let data = makeRows(0, 50);
    const { result, rerender } = renderHook(
      ({ rows }) => useInfiniteScroll(rows, keyFn),
      { initialProps: { rows: data } },
    );
    expect(result.current.visibleData).toHaveLength(50);

    // User hits the bottom: nothing buffered, the fetch is on the wire.
    act(() => result.current.loadMore());
    expect(result.current.visibleData).toHaveLength(50);

    // The fetched page lands — it must paint without another loadMore.
    data = [...data, ...makeRows(50, 50)];
    rerender({ rows: data });
    expect(result.current.visibleData).toHaveLength(100);
  });

  it("does not grow the window on a background prefetch append", () => {
    let data = makeRows(0, 100);
    const { result, rerender } = renderHook(
      ({ rows }) => useInfiniteScroll(rows, keyFn),
      { initialProps: { rows: data } },
    );
    // Window at 50, 50 rows still buffered — no end-of-list request made.
    expect(result.current.visibleData).toHaveLength(50);

    // Prefetch appends a page the user never asked to see.
    data = [...data, ...makeRows(100, 50)];
    rerender({ rows: data });
    expect(result.current.visibleData).toHaveLength(50);
  });

  it("resets the window when the data source is swapped", () => {
    let data = makeRows(0, 100);
    const { result, rerender } = renderHook(
      ({ rows }) => useInfiniteScroll(rows, keyFn),
      { initialProps: { rows: data } },
    );

    act(() => result.current.loadMore());
    expect(result.current.visibleData).toHaveLength(100);

    // Different first row = a different listing (navigation, sort change).
    data = makeRows(1000, 150);
    rerender({ rows: data });

    expect(result.current.visibleData).toHaveLength(50);
  });

  it("resets the window when rows change in place at the same length", () => {
    let data = makeRows(0, 100);
    const { result, rerender } = renderHook(
      ({ rows }) => useInfiniteScroll(rows, keyFn),
      { initialProps: { rows: data } },
    );

    act(() => result.current.loadMore());
    expect(result.current.visibleData).toHaveLength(100);

    // Same length and first row, but the tail was replaced — not an append.
    data = [...makeRows(0, 50), ...makeRows(500, 50)];
    rerender({ rows: data });

    expect(result.current.visibleData).toHaveLength(50);
  });
});

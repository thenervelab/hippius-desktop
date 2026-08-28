import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "@testing-library/react";
import type { RefObject } from "react";

import { useLoadMoreSentinel } from "../use-load-more-sentinel";

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

let observers: Array<{ callback: IOCallback; observed: Element[] }>;

class FakeIntersectionObserver {
  callback: IOCallback;
  observed: Element[] = [];
  constructor(callback: IOCallback) {
    this.callback = callback;
    observers.push({ callback, observed: this.observed });
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {}
  unobserve() {}
}

const latestObserver = () => observers[observers.length - 1];

describe("useLoadMoreSentinel", () => {
  let sentinelRef: RefObject<HTMLElement | null>;

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    sentinelRef = { current: document.createElement("div") };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires loadMore when the sentinel enters the viewport", () => {
    const loadMore = vi.fn();
    renderHook(() => useLoadMoreSentinel(sentinelRef, true, loadMore));

    act(() => latestObserver().callback([{ isIntersecting: true }]));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  // The chain-fetch regression: the observer re-attaches whenever `loadMore`
  // changes identity (every appended page) and reports current state on
  // attach. With few filtered rows the sentinel never leaves the viewport, so
  // "visible on re-attach" fetched the NEXT page for every completed one — a
  // loop of skeleton flashes while the whole remote folder was paged through.
  it("does not refire when the observer re-attaches while still visible", () => {
    const loadMore1 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useLoadMoreSentinel(sentinelRef, true, cb),
      { initialProps: { cb: loadMore1 } },
    );

    act(() => latestObserver().callback([{ isIntersecting: true }]));
    expect(loadMore1).toHaveBeenCalledTimes(1);

    // Page appended -> new loadMore identity -> observer re-attaches and
    // reports "still visible".
    const loadMore2 = vi.fn();
    rerender({ cb: loadMore2 });
    act(() => latestObserver().callback([{ isIntersecting: true }]));
    expect(loadMore2).not.toHaveBeenCalled();
  });

  it("fires again only after a genuine leave -> enter transition", () => {
    const loadMore = vi.fn();
    renderHook(() => useLoadMoreSentinel(sentinelRef, true, loadMore));

    act(() => latestObserver().callback([{ isIntersecting: true }]));
    act(() => latestObserver().callback([{ isIntersecting: false }]));
    act(() => latestObserver().callback([{ isIntersecting: true }]));
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("does not observe at all when hasMore is false", () => {
    const loadMore = vi.fn();
    renderHook(() => useLoadMoreSentinel(sentinelRef, false, loadMore));
    expect(observers).toHaveLength(0);
  });
});

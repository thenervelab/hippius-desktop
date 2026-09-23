// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore, useAtom } from "jotai";
import React from "react";

import { browsePageSizeAtom } from "@/app/lib/global-atoms/drivePagingAtoms";
import {
  BROWSE_PAGE_SIZE_STORAGE_KEY as KEY,
  DEFAULT_BROWSE_PAGE_SIZE,
} from "@/app/components/page-sections/drive/browsePager";

/**
 * The size used to be `useState` in DriveContainer, so it died the moment the
 * reader left Drive for Overview or Support: they set 50, came back, and were
 * on 20 again with no indication why.
 */
const mountPager = () => {
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook(() => useAtom(browsePageSizeAtom), { wrapper });
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("the remembered page size", () => {
  it("opens at the default before anything is chosen", () => {
    const { result } = mountPager();
    expect(result.current[0]).toBe(DEFAULT_BROWSE_PAGE_SIZE);
  });

  it("survives leaving Drive and coming back", () => {
    const first = mountPager();
    act(() => first.result.current[1](50));
    first.unmount();

    // A fresh store, as a remount after navigating away gets.
    const second = mountPager();
    expect(second.result.current[0]).toBe(50);
  });

  // The default is stored as absence, so a fresh install carries no key and
  // going back to it cleans the entry up rather than pinning today's default
  // forever.
  it("stores a choice, and clears the entry when set back to the default", () => {
    const { result } = mountPager();
    act(() => result.current[1](50));
    expect(window.localStorage.getItem(KEY)).toBe("50");

    act(() => result.current[1](DEFAULT_BROWSE_PAGE_SIZE));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores a stored value that would break the page maths", () => {
    window.localStorage.setItem(KEY, "0");
    expect(mountPager().result.current[0]).toBe(DEFAULT_BROWSE_PAGE_SIZE);
  });

  /**
   * A private window, blocked site data or a thumbnail capture can make
   * localStorage throw. A drive that will not render because its page size
   * could not be read is a far worse failure than one that opens at twenty.
   */
  it("still opens when storage cannot be read", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      expect(mountPager().result.current[0]).toBe(DEFAULT_BROWSE_PAGE_SIZE);
    } finally {
      getItem.mockRestore();
    }
  });

  it("still changes the size when storage cannot be written", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      const { result } = mountPager();
      act(() => result.current[1](50));
      expect(result.current[0]).toBe(50);
    } finally {
      setItem.mockRestore();
    }
  });
});

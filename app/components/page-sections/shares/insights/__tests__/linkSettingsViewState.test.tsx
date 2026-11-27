import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

import {
  fileLinkViewKey,
  folderLinkViewKey,
  linkSettingsViewsAtom,
  useLinkSettingsView,
} from "../linkSettingsViewState";

describe("which view an Insights panel shows, per link", () => {
  it("keeps each link's view apart, and keeps nothing for a closed one", () => {
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
    const a = renderHook(() => useLinkSettingsView(fileLinkViewKey("a")), { wrapper });
    const b = renderHook(() => useLinkSettingsView(fileLinkViewKey("b")), { wrapper });
    const folder = renderHook(() => useLinkSettingsView(folderLinkViewKey("a")), { wrapper });

    expect(a.result.current.isOpen).toBe(false);
    act(() => a.result.current.show());
    act(() => a.result.current.setRule("allowList"));
    expect(a.result.current).toMatchObject({ isOpen: true, rule: "allowList" });
    // Another link, and a folder link with the same id, are untouched.
    expect(b.result.current).toMatchObject({ isOpen: false, rule: null });
    expect(folder.result.current).toMatchObject({ isOpen: false, rule: null });

    // Opening afresh from the gear starts at Link settings itself.
    act(() => a.result.current.show());
    expect(a.result.current.rule).toBeNull();

    act(() => a.result.current.hide());
    expect(a.result.current).toMatchObject({ isOpen: false, rule: null });
    expect(store.get(linkSettingsViewsAtom)).toEqual({});
  });
});

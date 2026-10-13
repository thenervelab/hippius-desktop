import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

import { newestShareToken, useCaptureInsightsItem } from "../useCaptureInsightsItem";
import { DriveRouteContext, type DriveRoute } from "../driveRoute";
import { insightsSheetAtom, serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities, ShareSummary } from "@/app/lib/tauri/shares";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const ROWS: ShareSummary[] = [
  { shareToken: "old", createdAt: "2026-10-01T10:00:00Z" },
  { shareToken: "new", createdAt: "2026-10-12T10:00:00Z" },
] as ShareSummary[];

vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({
    getSharesFor: (label: string, path: string) =>
      label === "Captures" && path === "Screenshot.png" ? ROWS : [],
    isLoading: false,
  }),
}));

const CAPS = { shares: true, share_insights: true } as ServerCapabilities;
const FILE = { name: "Screenshot.png", actualFileName: "Screenshot.png", label: "Captures", isFolder: false } as FormattedUserFile;

function setup(basePath: string, caps: ServerCapabilities = CAPS) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
  const route = { basePath } as DriveRoute;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <DriveRouteContext.Provider value={route}>{children}</DriveRouteContext.Provider>
    </Provider>
  );
  const { result } = renderHook(() => useCaptureInsightsItem(), { wrapper });
  return { item: result.current, store };
}

describe("useCaptureInsightsItem", () => {
  it("picks the newest link", () => {
    expect(newestShareToken(ROWS)).toBe("new");
    expect(newestShareToken([])).toBeNull();
  });

  it("offers Insights for a capture with a link on the Captures page, and opens its newest link", () => {
    const { item, store } = setup("/captures");
    const items = item(FILE, "Screenshot.png");
    expect(items).toHaveLength(1);
    expect(items[0].itemTitle).toBe("Insights");
    items[0].onItemClick?.();
    expect(store.get(insightsSheetAtom)).toEqual({ shareToken: "new", fileName: "Screenshot.png" });
  });

  it("offers nothing elsewhere, without a link, for a folder, or on a server without Insights", () => {
    expect(setup("/files").item(FILE, "Screenshot.png")).toEqual([]);
    expect(setup("/captures").item(FILE, "Other.png")).toEqual([]);
    expect(setup("/captures").item({ ...FILE, isFolder: true }, "Screenshot.png")).toEqual([]);
    expect(setup("/captures", { shares: true } as ServerCapabilities).item(FILE, "Screenshot.png")).toEqual([]);
  });
});

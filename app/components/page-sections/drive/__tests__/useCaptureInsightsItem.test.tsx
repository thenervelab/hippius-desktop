import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

import {
  captureSharesFrom,
  isCaptureName,
  isCaptureMedia,
  newestShareToken,
  useCaptureInsightsItem,
  VIEW_INSIGHTS_LABEL,
} from "../useCaptureInsightsItem";
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
    getUnplacedSharesNamed: () => [],
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

  it("offers View insights for a capture with a link on the Captures page, and opens its newest link", () => {
    const { item, store } = setup("/captures");
    const items = item(FILE, "Screenshot.png");
    expect(items).toHaveLength(1);
    expect(items[0].itemTitle).toBe(VIEW_INSIGHTS_LABEL);
    items[0].onItemClick?.();
    // The file goes too, for the sheet's thumbnail, and the capture, for
    // making a link should this one be revoked.
    expect(store.get(insightsSheetAtom)).toEqual({
      shareToken: "new",
      fileName: "Screenshot.png",
      file: FILE,
      capture: { label: "Captures", relativePath: "Screenshot.png", fileId: null },
    });
  });

  it("offers View insights for every screenshot and recording, with a link or not", () => {
    const recording = { ...FILE, name: "Recording.mp4", actualFileName: "Recording.mp4" };
    const { item, store } = setup("/captures");
    const items = item(recording, "Recording.mp4");
    expect(items.map((i) => i.itemTitle)).toEqual([VIEW_INSIGHTS_LABEL]);
    items[0].onItemClick?.();
    // No link yet: the sheet opens on its "Create link" step.
    expect(store.get(insightsSheetAtom)).toMatchObject({
      shareToken: null,
      capture: { label: "Captures", relativePath: "Recording.mp4", fileId: null },
    });
    expect(setup("/captures").item({ ...FILE, name: "Other.png", actualFileName: "Other.png" }, "Other.png")).toHaveLength(1);
  });

  it("passes the server id of a capture with no copy on this computer", () => {
    const cloud = { ...FILE, fileId: "abc123", source: undefined };
    const { item, store } = setup("/captures");
    item(cloud, "Screenshot.png")[0].onItemClick?.();
    expect(store.get(insightsSheetAtom)?.capture).toEqual({ label: "Captures", relativePath: "Screenshot.png", fileId: "abc123" });
  });

  it("offers nothing elsewhere, for a folder, for another kind of file, or on a server without Insights", () => {
    expect(setup("/files").item(FILE, "Screenshot.png")).toEqual([]);
    expect(setup("/captures").item({ ...FILE, isFolder: true }, "Screenshot.png")).toEqual([]);
    expect(setup("/captures").item({ ...FILE, name: "notes.pdf", actualFileName: "notes.pdf" }, "notes.pdf")).toEqual([]);
    expect(setup("/captures", { shares: true } as ServerCapabilities).item(FILE, "Screenshot.png")).toEqual([]);
  });
});

describe("captureSharesFrom", () => {
  const placed = { shareToken: "here", createdAt: "2026-10-01T10:00:00Z" } as ShareSummary;
  const elsewhere = {
    shareToken: "ext",
    createdAt: "2026-10-02T10:00:00Z",
    filename: "Recording 2026-10-28 at 16.04.09.mp4",
    plaintextSize: 100,
  } as ShareSummary;
  const lookups = {
    getSharesFor: (label: string | null | undefined, path: string | null | undefined) =>
      label === "Captures" && path === "Clips/Recording 2026-10-28 at 16.04.09.mp4" ? [placed] : [],
    getUnplacedSharesNamed: (name: string | null | undefined) =>
      name === "Recording 2026-10-28 at 16.04.09.mp4" || name === "report.pdf" ? [elsewhere] : [],
  };

  it("adds links made elsewhere, matched by the capture's own name, to this device's", () => {
    expect(captureSharesFrom(lookups, "Captures", "Clips/Recording 2026-10-28 at 16.04.09.mp4", 100)).toEqual([placed, elsewhere]);
    // A size the listing does not know never rules a link out.
    expect(captureSharesFrom(lookups, "Captures", "Clips/Recording 2026-10-28 at 16.04.09.mp4")).toEqual([placed, elsewhere]);
  });

  it("leaves out a link whose file had a different size", () => {
    expect(captureSharesFrom(lookups, "Captures", "Clips/Recording 2026-10-28 at 16.04.09.mp4", 101)).toEqual([placed]);
  });

  it("matches by name only for a capture's own name", () => {
    expect(captureSharesFrom(lookups, "Captures", "report.pdf", 100)).toEqual([]);
    // A plain picture name is not specific enough: another file's link
    // made elsewhere under the same name must not show on this one.
    const plain = { ...lookups, getUnplacedSharesNamed: (name: string | null | undefined) => (name === "image.png" ? [elsewhere] : []) };
    expect(captureSharesFrom(plain, "Captures", "image.png", 100)).toEqual([]);
    expect(isCaptureName("Screenshot 2026-10-28 at 16.04.09.png")).toBe(true);
    expect(isCaptureName("Recording 2026-10-28 at 16.04.09 (edited).mp4")).toBe(true);
    expect(isCaptureName("Screenshot.png")).toBe(false);
    expect(isCaptureName("image.png")).toBe(false);
    expect(isCaptureMedia("Screenshot 2026-10-28 at 16.04.09.PNG")).toBe(true);
    expect(isCaptureMedia("Recording.mov")).toBe(true);
    expect(isCaptureMedia("notes")).toBe(false);
  });
});

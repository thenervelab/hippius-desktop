import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureInsightsButton, { VIEW_INSIGHTS_LABEL } from "../CaptureInsightsButton";
import { DriveRouteContext, type DriveRoute } from "../driveRoute";
import { insightsSheetAtom, serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities, ShareSummary } from "@/app/lib/tauri/shares";

const ROWS: ShareSummary[] = [
  { shareToken: "old", createdAt: "2026-10-01T10:00:00Z" },
  { shareToken: "new", createdAt: "2026-10-12T10:00:00Z" },
] as ShareSummary[];

const getSharesFor = vi.fn((label: string, path: string) =>
  label === "Captures" && path === "Recording.mp4" ? ROWS : [],
);
vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({ getSharesFor, isLoading: false }),
}));

const CAPS = { shares: true, share_insights: true } as ServerCapabilities;

function setup({
  basePath = "/captures",
  caps = CAPS,
  actualName = "Recording.mp4",
  onRowClick = vi.fn(),
}: {
  basePath?: string;
  caps?: ServerCapabilities;
  actualName?: string;
  onRowClick?: () => void;
} = {}) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
  render(
    <Provider store={store}>
      <DriveRouteContext.Provider value={{ basePath, pinned: null } as DriveRoute}>
        {/* The row's preview trigger: the button must not open the file. */}
        <div role="presentation" onClick={onRowClick}>
          <CaptureInsightsButton label="Captures" actualName={actualName} fileName="Recording.mp4" />
        </div>
      </DriveRouteContext.Provider>
    </Provider>,
  );
  return { store, onRowClick };
}

describe("CaptureInsightsButton", () => {
  it("opens the Insights sheet for the capture's newest link, without opening the file", () => {
    const { store, onRowClick } = setup();
    const button = screen.getByRole("button", { name: VIEW_INSIGHTS_LABEL });
    expect(button).toHaveAttribute("tabindex", "0");

    fireEvent.click(button);
    expect(store.get(insightsSheetAtom)).toEqual({ shareToken: "new", fileName: "Recording.mp4" });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens from the keyboard", () => {
    const { store } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: VIEW_INSIGHTS_LABEL }), { key: "Enter" });
    expect(store.get(insightsSheetAtom)).toEqual({ shareToken: "new", fileName: "Recording.mp4" });
  });

  it("is hidden for a capture with no link", () => {
    setup({ actualName: "Screenshot.png" });
    expect(screen.queryByRole("button", { name: VIEW_INSIGHTS_LABEL })).toBeNull();
  });

  it("is hidden on a server without Insights", () => {
    setup({ caps: { shares: true, share_insights: false } as ServerCapabilities });
    expect(screen.queryByRole("button", { name: VIEW_INSIGHTS_LABEL })).toBeNull();
  });

  it("is hidden off the Captures page, and looks nothing up there", () => {
    getSharesFor.mockClear();
    setup({ basePath: "/files" });
    expect(screen.queryByRole("button", { name: VIEW_INSIGHTS_LABEL })).toBeNull();
    expect(getSharesFor).not.toHaveBeenCalled();
  });
});

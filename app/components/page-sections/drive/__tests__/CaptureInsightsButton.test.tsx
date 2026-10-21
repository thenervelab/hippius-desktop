import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import CaptureInsightsButton, { InsightsButton, VIEW_INSIGHTS_LABEL, insightsButtonView } from "../CaptureInsightsButton";
import { linkSettingsQueryKey } from "@/components/page-sections/shares/insights/queryKeys";
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
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>
        <DriveRouteContext.Provider value={{ basePath, pinned: null } as DriveRoute}>
          {/* The row's preview trigger: the button must not open the file. */}
          <div role="presentation" onClick={onRowClick}>
            <CaptureInsightsButton label="Captures" actualName={actualName} fileName="Recording.mp4" />
          </div>
        </DriveRouteContext.Provider>
      </Provider>
    </QueryClientProvider>,
  );
  return { store, onRowClick };
}

describe("CaptureInsightsButton", () => {
  it("opens the Insights sheet for the capture's newest link, without opening the file", () => {
    const { store, onRowClick } = setup();
    const button = screen.getByRole("button", { name: VIEW_INSIGHTS_LABEL });
    expect(button).toHaveAttribute("tabindex", "0");

    fireEvent.click(button);
    expect(store.get(insightsSheetAtom)).toEqual({ shareToken: "new", fileName: "Recording.mp4", file: undefined });
    expect(onRowClick).not.toHaveBeenCalled();
    // A bordered button that says what it opens.
    expect(button).toHaveTextContent("Insights");
  });

  it("opens from the keyboard", () => {
    const { store } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: VIEW_INSIGHTS_LABEL }), { key: "Enter" });
    expect(store.get(insightsSheetAtom)).toEqual({ shareToken: "new", fileName: "Recording.mp4", file: undefined });
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

describe("the Insights button's words", () => {
  const share = { shareToken: "t", createdAt: "2026-10-12T10:00:00Z" } as ShareSummary;
  const off = { listingCounts: false, insightsSeen: false, insightsOff: false };

  it("says Insights while the listing carries no counts", () => {
    // Even if a count arrived, nothing reads it without the capability.
    expect(insightsButtonView({ ...share, views: 47, newSinceSeen: true }, off)).toEqual({
      label: "Insights",
      off: false,
      newSinceSeen: false,
    });
  });

  it("says Insights off when the link is known not to count views", () => {
    expect(insightsButtonView(share, { ...off, insightsOff: true })).toMatchObject({ label: "Insights off", off: true });
    expect(insightsButtonView({ ...share, insightsOn: false }, { ...off, listingCounts: true })).toMatchObject({
      label: "Insights off",
    });
  });

  it("carries the count and the new dot once the server has them", () => {
    expect(
      insightsButtonView({ ...share, views: 47, newSinceSeen: true }, { ...off, listingCounts: true, insightsSeen: true }),
    ).toEqual({ label: "47 views", off: false, newSinceSeen: true });
    expect(insightsButtonView({ ...share, views: 1 }, { ...off, listingCounts: true }).label).toBe("1 view");
  });
});

describe("InsightsButton", () => {
  function renderButton(caps: ServerCapabilities, seed?: (c: QueryClient) => void, extra: Partial<ShareSummary> = {}) {
    const store = createStore();
    store.set(serverCapabilitiesAtom, caps);
    const client = new QueryClient();
    seed?.(client);
    render(
      <QueryClientProvider client={client}>
        <Provider store={store}>
          <InsightsButton
            share={{ shareToken: "tok", createdAt: "2026-10-12T10:00:00Z", ...extra } as ShareSummary}
            fileName="Recording.mp4"
          />
        </Provider>
      </QueryClientProvider>,
    );
  }

  it("reads Insights off from what the sheet already loaded, dashed", () => {
    renderButton(CAPS, (c) =>
      c.setQueryData(linkSettingsQueryKey("tok"), {
        offered: { insights: true, comments: true, reactions: true },
        on: { insights: false, comments: true, reactions: true },
        insightsInPlan: true,
      }),
    );
    const button = screen.getByTestId("capture-insights-button");
    expect(button).toHaveTextContent("Insights off");
    expect(button).toHaveAttribute("data-off", "true");
    expect(button.className).toContain("border-dashed");
  });

  it("shows no count and no dot today, even if the listing sent them", () => {
    renderButton(CAPS, undefined, { views: 47, newSinceSeen: true });
    expect(screen.getByTestId("capture-insights-button")).toHaveTextContent(/^Insights$/);
    expect(screen.queryByTestId("insights-new-dot")).toBeNull();
  });

  it("shows the count and the dot once the server advertises them", () => {
    renderButton({ ...CAPS, share_listing_counts: true, share_insights_seen: true }, undefined, {
      views: 47,
      newSinceSeen: true,
    });
    const button = screen.getByRole("button", { name: "47 views, view insights, new since you last looked" });
    expect(button).toHaveTextContent("47 views");
    expect(screen.getByTestId("insights-new-dot")).toBeInTheDocument();
  });
});

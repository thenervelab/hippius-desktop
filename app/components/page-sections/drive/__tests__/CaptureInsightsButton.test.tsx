import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import CaptureInsightsButton, {
  InsightsButton,
  NO_LINK_TOOLTIP,
  VIEW_INSIGHTS_LABEL,
  insightsButtonView,
} from "../CaptureInsightsButton";
import { linkSettingsQueryKey } from "@/components/page-sections/shares/insights/queryKeys";
import { DriveRouteContext, type DriveRoute } from "../driveRoute";
import { insightsSheetAtom, serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities, ShareSummary } from "@/app/lib/tauri/shares";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const ROWS: ShareSummary[] = [
  { shareToken: "old", createdAt: "2026-10-01T10:00:00Z" },
  { shareToken: "new", createdAt: "2026-10-12T10:00:00Z" },
] as ShareSummary[];

const getSharesFor = vi.fn((label: string, path: string) =>
  label === "Captures" && path === "Recording.mp4" ? ROWS : [],
);
// A link made in the browser extension: the listing has no origin for it,
// only the name and size of the file it was made from.
const EXTENSION_ROW = {
  shareToken: "ext",
  createdAt: "2026-10-20T10:00:00Z",
  filename: "Recording 2026-10-20 at 09.15.02.mp4",
  plaintextSize: 2048,
} as ShareSummary;
const getUnplacedSharesNamed = vi.fn((name: string) => (name === "Recording 2026-10-20 at 09.15.02.mp4" ? [EXTENSION_ROW] : []));
vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({ getSharesFor, getUnplacedSharesNamed, isLoading: false }),
}));

const CAPS = { shares: true, share_insights: true } as ServerCapabilities;

function setup({
  basePath = "/captures",
  caps = CAPS,
  actualName = "Recording.mp4",
  onRowClick = vi.fn(),
  size,
}: {
  basePath?: string;
  caps?: ServerCapabilities;
  actualName?: string;
  onRowClick?: () => void;
  size?: number;
} = {}) {
  const file = size === undefined ? undefined : ({ name: actualName, actualFileName: actualName, label: "Captures", size } as FormattedUserFile);
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>
        <DriveRouteContext.Provider value={{ basePath, pinned: null } as DriveRoute}>
          {/* The row's preview trigger: the button must not open the file. */}
          <div role="presentation" onClick={onRowClick}>
            <CaptureInsightsButton label="Captures" actualName={actualName} fileName={actualName} file={file} />
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
    expect(store.get(insightsSheetAtom)).toEqual({
      shareToken: "new",
      fileName: "Recording.mp4",
      file: undefined,
      capture: { label: "Captures", relativePath: "Recording.mp4" },
    });
    expect(onRowClick).not.toHaveBeenCalled();
    // A bordered button that says what it opens.
    expect(button).toHaveTextContent("Insights");
  });

  it("opens from the keyboard", () => {
    const { store } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: VIEW_INSIGHTS_LABEL }), { key: "Enter" });
    expect(store.get(insightsSheetAtom)).toMatchObject({ shareToken: "new", fileName: "Recording.mp4" });
  });

  it("shows a quieter button for a capture with no link, which opens the sheet to create one", () => {
    const { store, onRowClick } = setup({ actualName: "Screenshot.png" });
    const button = screen.getByRole("button", { name: `${VIEW_INSIGHTS_LABEL}, no link yet` });
    expect(button).toHaveTextContent(/^Insights$/);
    expect(button).toHaveAttribute("data-no-link", "true");
    // The chart icon goes grey: only rows with a link carry the brand colour.
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("text-grey-60");

    fireEvent.click(button);
    expect(store.get(insightsSheetAtom)).toEqual({
      shareToken: null,
      fileName: "Screenshot.png",
      file: undefined,
      capture: { label: "Captures", relativePath: "Screenshot.png" },
    });
    expect(onRowClick).not.toHaveBeenCalled();
    expect(NO_LINK_TOOLTIP).toMatch(/create/i);
  });

  it("finds a link made elsewhere by the capture's name, unless the sizes differ", () => {
    const first = setup({ actualName: "Recording 2026-10-20 at 09.15.02.mp4", size: 2048 });
    fireEvent.click(screen.getByRole("button", { name: VIEW_INSIGHTS_LABEL }));
    expect(first.store.get(insightsSheetAtom)?.shareToken).toBe("ext");
  });

  it("does not take a link made from a different file of the same name", () => {
    setup({ actualName: "Recording 2026-10-20 at 09.15.02.mp4", size: 999 });
    expect(screen.getByRole("button", { name: `${VIEW_INSIGHTS_LABEL}, no link yet` })).toBeInTheDocument();
  });

  it("does not take another file's link by a plain name", () => {
    const real = getUnplacedSharesNamed.getMockImplementation()!;
    getUnplacedSharesNamed.mockImplementation((name: string) => (name === "image.png" ? [EXTENSION_ROW] : []));
    try {
      setup({ actualName: "image.png", size: 2048 });
      expect(screen.getByRole("button", { name: `${VIEW_INSIGHTS_LABEL}, no link yet` })).toBeInTheDocument();
    } finally {
      getUnplacedSharesNamed.mockImplementation(real);
    }
  });

  it("is hidden for a file that is not a screenshot or recording", () => {
    setup({ actualName: "notes.pdf" });
    expect(screen.queryByTestId("capture-insights-button")).toBeNull();
  });

  it("is hidden on a server without Insights", () => {
    setup({ caps: { shares: true, share_insights: false } as ServerCapabilities });
    expect(screen.queryByRole("button", { name: VIEW_INSIGHTS_LABEL })).toBeNull();
  });

  it("is hidden off the Captures page, and looks nothing up there", () => {
    getSharesFor.mockClear();
    getUnplacedSharesNamed.mockClear();
    setup({ basePath: "/files" });
    expect(screen.queryByTestId("capture-insights-button")).toBeNull();
    expect(getSharesFor).not.toHaveBeenCalled();
    expect(getUnplacedSharesNamed).not.toHaveBeenCalled();
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
        switchesInPlan: true,
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

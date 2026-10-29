import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionGlobalConfig } from "framer-motion";

import ShareInsightsSheet, { CREATE_LINK, NO_LINK_TITLE, noLinkBody } from "../ShareInsightsSheet";
import {
  insightsSheetAtom,
  serverCapabilitiesAtom,
  type InsightsSheetTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities, ShareSummary } from "@/app/lib/tauri/shares";
import type { ShareInsights } from "@/app/lib/tauri/shareInsights";

// The Insights panel for a capture opened before a link was known (a
// Captures row with none, or the tray's "View insights"): it finds the
// capture's link in the share listing, else offers "Create link".

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Acct" }),
}));
vi.mock("@/app/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks")>();
  return {
    ...actual,
    useBreakpoint: () => ({
      breakpoint: "xl",
      isMobile: false,
      isTablet: false,
      isLaptop: false,
      isDesktop: true,
      isLargeDesktop: false,
    }),
  };
});
MotionGlobalConfig.skipAnimations = true;

const CAPS = { shares: true, share_insights: true, share_comments: true } as ServerCapabilities;
const NAME = "Recording 2026-10-28 at 16.04.09.mp4";
const TARGET: InsightsSheetTarget = {
  shareToken: null,
  fileName: NAME,
  capture: { label: "Hippius Captures", relativePath: NAME, fileId: null },
};
const PAID: ShareInsights = {
  plan: "paid",
  totalViews: 3,
  uniqueViewers: 2,
  completion: { state: "shown", value: 0.5 },
  retention: { state: "shown", value: [100, 80] },
  viewers: { state: "shown", value: [] },
};
const ALL_ON = { insights: true, comments: true, reactions: true };

function link(token: string, extra: Partial<ShareSummary> = {}): ShareSummary {
  return {
    shareToken: token,
    filename: NAME,
    plaintextSize: 10,
    ciphertextSize: 12,
    mimeType: "video/mp4",
    createdAt: "2026-10-28T16:05:00Z",
    expiresAt: null,
    shareUrl: `https://console.hippius.com/s/${token}`,
    isPrivate: false,
    folderLabel: "Hippius Captures",
    relativePath: NAME,
    ...extra,
  };
}

/** Answers the IPC calls by command; `hcfs_list_shares` from `listing()`. */
function answer(listing: () => ShareSummary[] | Promise<ShareSummary[]>, extra: Record<string, unknown> = {}) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "hcfs_list_shares") return Promise.resolve(listing());
    if (cmd in extra) return Promise.resolve(extra[cmd]);
    if (cmd === "share_get_insights") return Promise.resolve(PAID);
    if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
    if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
    if (cmd === "share_get_link_settings") return Promise.resolve({ offered: ALL_ON, on: ALL_ON, switchesInPlan: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

function renderSheet(target: InsightsSheetTarget = TARGET) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, CAPS);
  store.set(insightsSheetAtom, target);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <ShareInsightsSheet />
      </Provider>
    </QueryClientProvider>,
  );
  return store;
}

describe("the Insights panel for a capture with no link", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    toastSuccess.mockReset();
  });

  it("explains what Insights need and makes nothing until Create link is pressed", async () => {
    answer(() => []);
    renderSheet();
    expect(await screen.findByText(noLinkBody(true))).toBeInTheDocument();
    expect(screen.getAllByText(NO_LINK_TITLE).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: `Insights for ${NAME}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CREATE_LINK })).toBeEnabled();
    expect(invokeMock).not.toHaveBeenCalledWith("create_capture_link", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("share_get_insights", expect.anything());
  });

  it("holds a skeleton while the listing loads, so it never offers a link the capture already has", async () => {
    answer(() => new Promise<ShareSummary[]>(() => {}));
    renderSheet();
    expect(await screen.findByTestId("insights-loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CREATE_LINK })).toBeNull();
  });

  it("opens the capture's newest link when the listing has one", async () => {
    answer(() => [link("older", { createdAt: "2026-10-28T10:00:00Z" }), link("newest")]);
    renderSheet();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "newest" }));
    expect(screen.queryByRole("button", { name: CREATE_LINK })).toBeNull();
  });

  it("finds a link made elsewhere (no origin on this device) by the capture's name", async () => {
    answer(() => [link("ext", { folderLabel: null, relativePath: null })]);
    renderSheet();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "ext" }));
  });

  it("Create link makes the link through Rust, then shows that link's Insights", async () => {
    let listing: ShareSummary[] = [];
    answer(() => listing, {
      create_capture_link: { shareToken: "fresh", shareUrl: "https://console.hippius.com/s/fresh", copied: true },
    });
    const store = renderSheet({ ...TARGET, capture: { label: "Hippius Captures", relativePath: NAME, fileId: "abc" } });
    const button = await screen.findByRole("button", { name: CREATE_LINK });
    listing = [link("fresh")];
    fireEvent.click(button);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("create_capture_link", {
        folderLabel: "Hippius Captures",
        relativePath: NAME,
        fileId: "abc",
      }),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "fresh" }));
    expect(store.get(insightsSheetAtom)?.shareToken).toBe("fresh");
    expect(toastSuccess).toHaveBeenCalledWith("Link created and copied");
    // The panel stayed open; its heading takes focus from the button that went.
    await waitFor(() => expect(screen.getByRole("heading", { name: `Insights for ${NAME}` })).toHaveFocus());
    // The listing is asked again, so the row's badge and button show the link.
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "hcfs_list_shares").length).toBeGreaterThan(1);
  });

  it("says why when the link could not be made, and lets the user try again", async () => {
    answer(() => []);
    renderSheet();
    const button = await screen.findByRole("button", { name: CREATE_LINK });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_capture_link"
        ? Promise.reject({ kind: "Validation", message: "Storage is full. Upgrade your plan to upload this capture." })
        : Promise.resolve([]),
    );
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage is full.");
    expect(screen.getByRole("button", { name: CREATE_LINK })).toBeEnabled();
  });
});

// Shared Links carries each link's Insights in the table: an Insights button
// on every row, Views and Comments for file links once the listing carries
// them, and a folder link's Insights from its row (button and menu). All of
// it waits on the server's capabilities.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import "@testing-library/jest-dom";

import type { FolderShareSummary, ServerCapabilities, ShareSummary } from "@/app/lib/tauri/shares";
import type { LinkActivity } from "@/app/lib/tauri/folderInsights";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { folderInsightsAtom } from "@/components/page-sections/shares/folder-insights/folderInsightsTarget";
import { insightsSheetAtom } from "@/app/lib/global-atoms/sharesAtoms";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/shares",
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Account" }) }));
vi.mock("@/components/dashboard-title-wrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const FILE: ShareSummary = {
  shareToken: "tok1",
  filename: "report.pdf",
  plaintextSize: 10,
  ciphertextSize: 10,
  mimeType: "application/pdf",
  createdAt: "2026-11-02T10:00:00Z",
  expiresAt: null,
  shareUrl: "https://console.hippius.com/share/tok1#k=x",
  isPrivate: false,
  folderLabel: null,
  relativePath: null,
};
const FOLDER = {
  tokenHash: "b".repeat(64),
  folderHash: "0123456789abcdef",
  pathPrefix: "Room",
  displayName: "Board room",
  createdAt: "2026-11-01T10:00:00Z",
  expiresAt: null,
  revokedAt: null,
  resolvable: true,
  shareToken: "ftok",
  shareUrl: "https://console.hippius.com/share/folder/ftok#s=x",
  isPrivate: false,
  source: "drive",
  linkFormat: "envelope",
  reshareOffered: false,
} as unknown as FolderShareSummary;

const ACTIVITY: LinkActivity = {
  files: [{ shareToken: "tok1", insightsOn: true, counts: { views: 12, uniqueViewers: 7, comments: 3, newSinceSeen: false } }],
  folders: [{ tokenHash: FOLDER.tokenHash, insightsOn: false }],
};

const activityMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/shares", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shares")>()),
  listShares: vi.fn(async () => [FILE]),
  listFolderShares: vi.fn(async () => [FOLDER]),
}));
vi.mock("@/app/lib/tauri/shareHistory", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shareHistory")>()),
  listShareHistory: vi.fn(async () => []),
}));
vi.mock("@/app/lib/tauri/folderInsights", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/folderInsights")>()),
  getLinkActivity: activityMock,
}));

import MySharesPage from "../page";

const ALL_ON = {
  shares: true,
  folder_shares: true,
  folder_share_revoke_by_hash: true,
  folder_grants: false,
  share_insights: true,
  share_listing_counts: true,
  folder_share_insights: true,
} as ServerCapabilities;

function renderPage(caps: ServerCapabilities | null) {
  act(() => getDefaultStore().set(serverCapabilitiesAtom, caps));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MySharesPage />
    </QueryClientProvider>,
  );
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

beforeEach(() => {
  nav.search = "";
  nav.replace.mockReset();
  getDefaultStore().set(insightsSheetAtom, null);
  activityMock.mockReset();
  activityMock.mockResolvedValue(ACTIVITY);
  getDefaultStore().set(folderInsightsAtom, null);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("Shared Links insight columns", () => {
  it("shows Insights, Views and Comments, from the activity Rust reads", async () => {
    renderPage(ALL_ON);
    await screen.findByText("report.pdf");
    for (const header of ["Insights", "Views", "Comments"]) {
      expect(screen.getByRole("columnheader", { name: new RegExp(header) })).toBeInTheDocument();
    }
    const file = rowOf("report.pdf");
    await waitFor(() => expect(within(file).getByText("12")).toBeInTheDocument());
    expect(within(file).getByText("3")).toBeInTheDocument();
    // The Views column says the count, so the button keeps its word.
    expect(within(file).getByTestId("capture-insights-button")).toHaveTextContent("Insights");
  });

  it("opens a folder link's Insights from its row, with the switch the listing reports", async () => {
    renderPage(ALL_ON);
    await screen.findByText("Board room");
    const folder = rowOf("Board room");
    const button = await within(folder).findByTestId("capture-insights-button");
    await waitFor(() => expect(button).toHaveTextContent("Insights off"));
    fireEvent.click(button);
    expect(getDefaultStore().get(folderInsightsAtom)).toEqual({
      tokenHash: FOLDER.tokenHash,
      name: "Board room",
      createdAt: FOLDER.createdAt,
      expiresAt: null,
      revoked: false,
      paused: false,
      held: false,
      insightsOn: false,
    });
  });

  it("offers neither column nor request on a server without Insights", async () => {
    renderPage({ ...ALL_ON, share_insights: false, share_listing_counts: false, folder_share_insights: false });
    await screen.findByText("report.pdf");
    expect(screen.queryByRole("columnheader", { name: /Views/ })).toBeNull();
    expect(screen.queryByTestId("capture-insights-button")).toBeNull();
    expect(activityMock).not.toHaveBeenCalled();
  });

  it("keeps file insights but gives folder rows none until the server has folder Insights", async () => {
    renderPage({ ...ALL_ON, share_listing_counts: false, folder_share_insights: false });
    await screen.findByText("Board room");
    expect(screen.queryByRole("columnheader", { name: /Views/ })).toBeNull();
    expect(within(rowOf("report.pdf")).getByTestId("capture-insights-button")).toBeInTheDocument();
    expect(within(rowOf("Board room")).queryByTestId("capture-insights-button")).toBeNull();
  });

  it("opens the link a notification or the tray names, once the listing has it", async () => {
    nav.search = "insights=tok1";
    renderPage(ALL_ON);
    await waitFor(() =>
      expect(getDefaultStore().get(insightsSheetAtom)).toEqual({ shareToken: "tok1", fileName: "report.pdf" }),
    );
    // Dropped, so a reload or Back does not open it again.
    expect(nav.replace).toHaveBeenCalledWith("/shares");
  });

  it("opens nothing for a link no longer listed", async () => {
    nav.search = "insights=gone";
    renderPage(ALL_ON);
    await screen.findByText("report.pdf");
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/shares"));
    expect(getDefaultStore().get(insightsSheetAtom)).toBeNull();
  });
});

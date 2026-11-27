// While a shared folder is in Drive Trash the server keeps its folder links
// off and says so on the listing (`paused`, `held`), which Rust carries to the
// row. The Shared Links table marks such a link "Paused", as the console does,
// and only when the server said so.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import "@testing-library/jest-dom";

import type { FolderShareSummary } from "@/app/lib/tauri/shares";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/shares",
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Account" }),
}));
vi.mock("@/components/dashboard-title-wrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function folderRow(over: Partial<FolderShareSummary>): FolderShareSummary {
  return {
    tokenHash: "ab".repeat(32),
    folderHash: "37a8eec1ce19687d",
    pathPrefix: "Trips",
    displayName: "Holiday",
    createdAt: "2026-10-01T10:00:00Z",
    expiresAt: null,
    revokedAt: null,
    resolvable: true,
    shareToken: "folder-tok",
    shareUrl: "https://console.hippius.com/share/folder/folder-tok#k=x",
    isPrivate: true,
    source: "drive",
    linkFormat: "legacy",
    reshareOffered: false,
    ...over,
  };
}

const listFolderShares = vi.fn<() => Promise<FolderShareSummary[]>>();

vi.mock("@/app/lib/tauri/shares", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shares")>()),
  listShares: vi.fn(async () => []),
  listFolderShares: () => listFolderShares(),
}));
vi.mock("@/app/lib/tauri/shareHistory", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shareHistory")>()),
  listShareHistory: vi.fn(async () => []),
}));

import MySharesPage from "../page";

function renderPage() {
  const store = createStore();
  store.set(serverCapabilitiesAtom, {
    shares: true,
    folder_shares: true,
    folder_share_revoke_by_hash: false,
    share_owner_wrap: false,
    folder_grants: false,
    folder_share_link_envelopes: true,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Provider store={store}>
      <QueryClientProvider client={client}>
        <MySharesPage />
      </QueryClientProvider>
    </Provider>,
  );
}


async function rowOf(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest("tr") as HTMLElement;
}

describe("/shares Paused badge on a folder link in Trash", () => {
  beforeEach(() => {
    listFolderShares.mockReset();
  });

  it("shows Paused, with why, on a link the server paused", async () => {
    listFolderShares.mockResolvedValue([
      folderRow({ tokenHash: "a".repeat(64), displayName: "Holiday", paused: true, held: false }),
      folderRow({ tokenHash: "b".repeat(64), displayName: "Team", paused: true, held: true }),
    ]);
    renderPage();

    const holiday = within(await rowOf("Holiday")).getByTestId("folder-link-paused");
    expect(holiday).toHaveTextContent("Paused");
    expect(holiday).toHaveAttribute("title", "Off while its folder is in Trash");

    const team = within(await rowOf("Team")).getByTestId("folder-link-paused");
    expect(team).toHaveAttribute("title", "Off until you revoke it: its folder left Trash another way");
  });

  it("shows nothing when the server did not say, and Revoked over Paused", async () => {
    listFolderShares.mockResolvedValue([
      folderRow({ tokenHash: "c".repeat(64), displayName: "Older server" }),
      folderRow({ tokenHash: "d".repeat(64), displayName: "Live", paused: false, held: false }),
      folderRow({ tokenHash: "e".repeat(64), displayName: "Gone", paused: true, revokedAt: "2026-11-02T10:00:00Z" }),
    ]);
    renderPage();

    for (const name of ["Older server", "Live", "Gone"]) {
      expect(within(await rowOf(name)).queryByTestId("folder-link-paused")).not.toBeInTheDocument();
    }
    expect(within(await rowOf("Live")).getByText("Never")).toBeInTheDocument();
    expect(within(await rowOf("Gone")).getByText("Revoked")).toBeInTheDocument();
  });
});

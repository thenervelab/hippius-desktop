// A folder link minted before hcfs #665 carries the key to the owner's whole
// drive. Where Rust says this device can replace it, the shares page marks
// the row "Old link" and offers a reshare, and shows the new link (and its
// new password) once, since the password is never stored.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import "@testing-library/jest-dom";

import type { FolderShareSummary, ReshareOutcome } from "@/app/lib/tauri/shares";
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
    reshareOffered: true,
    ...over,
  };
}

const listFolderShares = vi.fn<() => Promise<FolderShareSummary[]>>();
const reshareFolderLink = vi.fn<(token: string) => Promise<ReshareOutcome>>();

vi.mock("@/app/lib/tauri/shares", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shares")>()),
  listShares: vi.fn(async () => []),
  listFolderShares: () => listFolderShares(),
  reshareFolderLink: (token: string) => reshareFolderLink(token),
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

/** Open the row's action menu the way a keyboard user does. */
async function openRowMenu(name: string) {
  const row = (await screen.findByText(name)).closest("tr") as HTMLElement;
  const trigger = within(row).getAllByRole("button").at(-1) as HTMLElement;
  fireEvent.keyDown(trigger, { key: "Enter" });
  return row;
}

describe("/shares reshare of a link that carries the drive key", () => {
  beforeEach(() => {
    listFolderShares.mockReset();
    reshareFolderLink.mockReset();
  });

  it("marks the row, reshares it, and shows the new link and password once", async () => {
    listFolderShares.mockResolvedValue([folderRow({})]);
    reshareFolderLink.mockResolvedValue({
      link: {
        shareToken: "new-tok",
        shareUrl: "https://console.hippius.com/share/folder/new-tok#sp=y",
        expiresAt: null,
        password: "fresh-password-1",
      },
      oldLinkRevoked: true,
    });
    renderPage();

    const row = await openRowMenu("Holiday");
    expect(within(row).getByText("Old link")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Reshare with a safer link"));

    await waitFor(() => expect(reshareFolderLink).toHaveBeenCalledWith("folder-tok"));
    expect(await screen.findByText("New link ready")).toBeInTheDocument();
    expect(screen.getByLabelText("New link")).toHaveValue("https://console.hippius.com/share/folder/new-tok#sp=y");
    expect(screen.getByLabelText("New password")).toHaveValue("fresh-password-1");
    expect(screen.getByText(/The old link no longer works/)).toBeInTheDocument();
  });

  it("says when the old link could not be turned off", async () => {
    listFolderShares.mockResolvedValue([folderRow({ isPrivate: false })]);
    reshareFolderLink.mockResolvedValue({
      link: { shareToken: "new-tok", shareUrl: "https://console.hippius.com/share/folder/new-tok#s=z", expiresAt: null },
      oldLinkRevoked: false,
    });
    renderPage();

    await openRowMenu("Holiday");
    fireEvent.click(await screen.findByText("Reshare with a safer link"));

    expect(await screen.findByText(/could not be turned off and still works/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("offers nothing where Rust did not", async () => {
    listFolderShares.mockResolvedValue([folderRow({ reshareOffered: false })]);
    renderPage();

    const row = await openRowMenu("Holiday");
    // The menu did open: its other items are there.
    expect(await screen.findByText("Copy link")).toBeInTheDocument();
    expect(screen.queryByText("Reshare with a safer link")).not.toBeInTheDocument();
    expect(within(row).queryByText("Old link")).not.toBeInTheDocument();
  });
});

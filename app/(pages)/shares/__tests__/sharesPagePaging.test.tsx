// Shared Links pages both lists ten at a time, in the client, over the sorted
// rows: no pager while ten or fewer fit, page 1 again after a sort change, a
// step back when a revoke or remove empties the last page, and the page of a
// row the drive's link badge pointed at.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom";

import type { ShareSummary } from "@/app/lib/tauri/shares";
import type { ShareHistoryEntry } from "@/app/lib/tauri/shareHistory";

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/shares",
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Account" }),
}));
vi.mock("@/components/dashboard-title-wrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const data = vi.hoisted(() => ({
  shares: [] as ShareSummary[],
  history: [] as ShareHistoryEntry[],
}));

/** `count` links named `link-01.txt`, ... in listing order. */
function shares(count: number): ShareSummary[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      shareToken: `t${n}`,
      filename: `link-${n}.txt`,
      plaintextSize: 10,
      ciphertextSize: 10,
      mimeType: "text/plain",
      createdAt: `2026-10-${n}T10:00:00Z`,
      expiresAt: null,
      shareUrl: `https://console.hippius.com/share/t${n}#k=x`,
      isPrivate: false,
    } as ShareSummary;
  });
}

function history(count: number): ShareHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      shareToken: `h${n}`,
      filename: `old-${n}.txt`,
      folderLabel: null,
      relativePath: null,
      plaintextSize: 10,
      mimeType: "text/plain",
      createdAt: `2026-09-${n}T10:00:00Z`,
      expiresAt: `2026-09-${n}T11:00:00Z`,
      endedAt: `2026-09-${n}T11:00:00Z`,
      endReason: "expired",
    } as ShareHistoryEntry;
  });
}

vi.mock("@/app/lib/tauri/shares", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shares")>()),
  listShares: vi.fn(async () => data.shares),
  listFolderShares: vi.fn(async () => []),
}));
vi.mock("@/app/lib/tauri/shareHistory", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shareHistory")>()),
  listShareHistory: vi.fn(async () => data.history),
}));

import MySharesPage from "../page";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MySharesPage />
    </QueryClientProvider>,
  );
  return client;
}

/** The names shown in the list whose rows carry `prefix`. */
function shownNames(prefix: string): string[] {
  return screen
    .queryAllByText(new RegExp(`^${prefix}-\\d+\\.txt$`))
    .map((el) => el.textContent ?? "");
}

function pageButton(n: number): HTMLElement {
  return screen.getByRole("button", { name: String(n) });
}

beforeEach(() => {
  search = "";
  data.shares = [];
  data.history = [];
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("Shared Links paging", () => {
  it("shows ten active links a page, and the rest on later pages", async () => {
    data.shares = shares(25);
    renderPage();
    // Newest first, as the list has always been ordered.
    await screen.findByText("link-25.txt");
    expect(shownNames("link")).toHaveLength(10);
    expect(screen.getAllByText("1-10 OUT OF 25").length).toBeGreaterThan(0);

    fireEvent.click(pageButton(3));
    await screen.findByText("link-05.txt");
    expect(shownNames("link")).toEqual(["link-05.txt", "link-04.txt", "link-03.txt", "link-02.txt", "link-01.txt"]);
  });

  it("draws no pager while ten or fewer fit", async () => {
    data.shares = shares(10);
    renderPage();
    await screen.findByText("link-10.txt");
    expect(shownNames("link")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(screen.queryByText(/OUT OF/)).toBeNull();
  });

  it("goes back to page 1 when the sort changes, and pages the sorted order", async () => {
    data.shares = shares(25);
    renderPage();
    await screen.findByText("link-25.txt");
    fireEvent.click(pageButton(2));
    await screen.findByText("link-15.txt");

    // Sort by name, A to Z: page 1 of the new order.
    fireEvent.click(screen.getAllByText("Name")[0]);
    await waitFor(() => expect(shownNames("link")[0]).toBe("link-01.txt"));
    expect(shownNames("link")).toHaveLength(10);
    expect(screen.getAllByText("1-10 OUT OF 25").length).toBeGreaterThan(0);
  });

  it("steps back a page when the last page empties", async () => {
    data.shares = shares(11);
    const client = renderPage();
    await screen.findByText("link-11.txt");
    fireEvent.click(pageButton(2));
    await screen.findByText("link-01.txt");

    // The oldest link is revoked: page 2 is gone.
    data.shares = shares(11).slice(1);
    await client.invalidateQueries();
    await screen.findByText("link-11.txt");
    expect(shownNames("link")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("opens the page of the row the drive's link badge pointed at", async () => {
    data.shares = shares(25);
    search = "highlight=file%3At03";
    renderPage();
    const row = (await screen.findByText("link-03.txt")).closest("tr") as HTMLElement;
    await waitFor(() => expect(row).toHaveAttribute("data-drive-highlight"));
    expect(shownNames("link")).toHaveLength(5);
  });

  it("pages the history ten at a time too", async () => {
    data.history = history(12);
    renderPage();
    const card = (await screen.findByText("old-01.txt")).closest("table")?.parentElement?.parentElement as HTMLElement;
    expect(shownNames("old")).toHaveLength(10);
    fireEvent.click(within(card).getByRole("button", { name: "2" }));
    await screen.findByText("old-11.txt");
    expect(shownNames("old")).toEqual(["old-11.txt", "old-12.txt"]);
  });
});

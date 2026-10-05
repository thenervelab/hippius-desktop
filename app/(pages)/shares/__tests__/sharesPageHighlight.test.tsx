// The drive's link badge opens /shares?highlight=<row ids>. With many links
// the file's row is hard to find, so the page points it out the way Drive's
// "Show in folder" does.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom";

import type { ShareSummary } from "@/app/lib/tauri/shares";

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

function share(token: string, filename: string): ShareSummary {
  return {
    shareToken: token,
    filename,
    plaintextSize: 10,
    ciphertextSize: 10,
    mimeType: "text/plain",
    createdAt: "2026-10-01T10:00:00Z",
    expiresAt: null,
    shareUrl: `https://console.hippius.com/share/${token}#k=x`,
    isPrivate: false,
  } as ShareSummary;
}

vi.mock("@/app/lib/tauri/shares", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shares")>()),
  listShares: vi.fn(async () => [share("t1", "a.txt"), share("t2", "b.txt")]),
  listFolderShares: vi.fn(async () => []),
}));
vi.mock("@/app/lib/tauri/shareHistory", async (orig) => ({
  ...(await orig<typeof import("@/app/lib/tauri/shareHistory")>()),
  listShareHistory: vi.fn(async () => []),
}));

import MySharesPage from "../page";

const scrollIntoView = vi.fn();

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MySharesPage />
    </QueryClientProvider>,
  );
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

describe("/shares highlight", () => {
  beforeEach(() => {
    scrollIntoView.mockReset();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  it("points out the row the badge was clicked for, and only that row", async () => {
    search = "highlight=file%3At2";
    renderPage();

    await screen.findByText("b.txt");
    // Drive's "Show in folder" highlight: globals.css draws and fades it.
    await waitFor(() => expect(rowOf("b.txt")).toHaveAttribute("data-drive-highlight"));
    expect(rowOf("a.txt")).not.toHaveAttribute("data-drive-highlight");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(rowOf("b.txt"));
  });

  it("marks nothing and does not scroll without the parameter", async () => {
    search = "";
    renderPage();

    await screen.findByText("b.txt");
    expect(document.querySelector("[data-drive-highlight]")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

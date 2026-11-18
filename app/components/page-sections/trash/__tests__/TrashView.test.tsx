import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";
import { toast } from "sonner";
import TrashView from "../TrashView";
import type { TrashListing, TrashRow } from "@/app/lib/tauri/trash";

const calls: Array<[string, Record<string, unknown>]> = [];
let listing: TrashListing;
let restoreAnswers: Array<Array<Record<string, unknown>>> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "list_trash") return Promise.resolve(listing);
    if (cmd === "restore_trash_items") return Promise.resolve(restoreAnswers.shift() ?? []);
    if (cmd === "delete_trash_items_forever") return Promise.resolve({ deleted: 1, failed: [] });
    if (cmd === "empty_trash") return Promise.resolve({ deleted: 2, failed: [] });
    return Promise.resolve(null);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
vi.mock("@/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/components/ui/page-header", () => ({
  default: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "t"), success: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

const row = (overrides: Partial<TrashRow> = {}): TrashRow => ({
  label: "hippius",
  driveName: "My Drive",
  shared: false,
  synced: true,
  canDeleteForever: true,
  itemId: "i1",
  isFolder: false,
  name: "report.pdf",
  parentPath: "Legal",
  path: "Legal/report.pdf",
  fileCount: 1,
  totalBytes: 2048,
  trashedAt: Math.floor(Date.now() / 1000),
  trashedBy: null,
  nameTaken: false,
  ...overrides,
});

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(queryClientAtom, queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <TrashView />
      </Provider>
    </QueryClientProvider>,
  );
}

const commands = () => calls.map(([cmd]) => cmd);

describe("TrashView", () => {
  beforeEach(() => {
    calls.length = 0;
    restoreAnswers = [];
    vi.clearAllMocks();
    listing = {
      items: [row()],
      drives: [{ label: "hippius", name: "My Drive", shared: false, canDeleteForever: true }],
      incomplete: false,
    };
  });

  it("says Trash is empty, and Empty trash is off", async () => {
    listing.items = [];
    renderView();
    expect(await screen.findByText("Trash is empty")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists an item with where it was, when, and its size, and no time limit", async () => {
    renderView();
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(screen.getAllByText(/My Drive \/ Legal/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Today/).length).toBeGreaterThan(0);
    expect(screen.getByText("2.05 KB")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/days left|Deletes in|retention|30 days/i);
  });

  it("restores in place and offers Show", async () => {
    restoreAnswers = [[{ label: "hippius", itemId: "i1", status: "restored", error: null, path: "Legal/report.pdf" }]];
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Restore report.pdf" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const sent = calls.find(([cmd]) => cmd === "restore_trash_items")![1];
    expect(sent.items).toEqual([
      { label: "hippius", itemId: "i1", path: "Legal/report.pdf", isFolder: false, fileCount: 1, onClash: "ask" },
    ]);
    const [title, options] = vi.mocked(toast.success).mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(title).toBe("Restored “report.pdf”");
    expect(options.action.label).toBe("Show");
    options.action.onClick();
    expect(push).toHaveBeenCalledWith(expect.stringContaining("openFile=report.pdf"));
  });

  it("asks Keep both or Skip when the name is taken, and keeps both on request", async () => {
    restoreAnswers = [
      [{ label: "hippius", itemId: "i1", status: "clash", error: null, path: "Legal/report.pdf" }],
      [{ label: "hippius", itemId: "i1", status: "restored", error: null, path: "Legal/report (1).pdf" }],
    ];
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Restore report.pdf" }));
    const keep = await screen.findByRole("button", { name: /Keep both/ });
    expect(screen.queryByRole("button", { name: /Replace/ })).toBeNull();
    fireEvent.click(keep);
    await waitFor(() => expect(calls.filter(([cmd]) => cmd === "restore_trash_items")).toHaveLength(2));
    const second = calls.filter(([cmd]) => cmd === "restore_trash_items")[1][1];
    expect((second.items as Array<{ onClash: string }>)[0].onClash).toBe("keepBoth");
  });

  it("asks before deleting forever, then deletes the selection", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select report.pdf" }));
    const toolbar = screen.getByRole("toolbar", { name: "Selected items" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Delete forever" }));
    expect(await screen.findByText("Delete forever?")).toBeTruthy();
    expect(screen.getByText("“report.pdf” will be deleted. This can't be undone.")).toBeTruthy();
    expect(commands()).not.toContain("delete_trash_items_forever");
    const confirmButtons = screen.getAllByRole("button", { name: "Delete forever" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(commands()).toContain("delete_trash_items_forever"));
    expect(calls.find(([cmd]) => cmd === "delete_trash_items_forever")![1].items).toEqual([{ label: "hippius", itemId: "i1" }]);
  });

  it("does not let an Editor delete forever", async () => {
    listing.items = [row({ canDeleteForever: false, shared: true })];
    renderView();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select report.pdf" }));
    const toolbar = screen.getByRole("toolbar", { name: "Selected items" });
    const button = within(toolbar).getByRole("button", { name: "Delete forever" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("empties Trash after asking", async () => {
    listing.items = [row(), row({ itemId: "i2", name: "b.txt", path: "b.txt", parentPath: "" })];
    renderView();
    await screen.findByText("b.txt");
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    expect(await screen.findByText("All 2 items in Trash will be deleted. This can't be undone.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    await waitFor(() => expect(commands()).toContain("empty_trash"));
    expect(calls.find(([cmd]) => cmd === "empty_trash")![1].labels).toEqual(["hippius"]);
  });

  it("selects every row with the header box", async () => {
    listing.items = [row(), row({ itemId: "i2", name: "b.txt" })];
    renderView();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
  });
});

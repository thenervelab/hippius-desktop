import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";

import type { StarredItem, StarredListing } from "@/app/lib/tauri/starred";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { driveStatusesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import StarredView from "../StarredView";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
vi.mock("@/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
const push = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => searchParams,
}));
// The Drive's container is tested with the Drive; here it says which page hosts it.
vi.mock("@/components/page-sections/drive/DriveContainer", async () => {
  const { useDriveRoute } = await import("@/components/page-sections/drive/driveRoute");
  return {
    default: function DriveContainerStub() {
      const route = useDriveRoute();
      return (
        <div data-testid="drive-container" data-base={route.basePath} data-parent={route.parent?.href ?? ""}>
          {route.parent?.label}
        </div>
      );
    },
  };
});
vi.mock("@/components/ui/page-header", () => ({
  default: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "t"), success: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));
// The Drive's own view is tested with the Drive. Here it shows what the
// page hands it: the rows, how they open, the view mode and the search.
vi.mock("@/components/page-sections/drive/DriveContent", async () => {
  const { useDriveRoute } = await import("@/components/page-sections/drive/driveRoute");
  const { useStars } = await import("@/app/lib/starred/useStars");
  return {
    default: function DriveContentStub({
      filteredData,
      viewMode,
      searchTerm,
      isLoading,
    }: {
      filteredData: FormattedUserFile[];
      viewMode: string;
      searchTerm: string;
      isLoading: boolean;
    }) {
      const route = useDriveRoute();
      const { toggleRow } = useStars(filteredData.map((r) => r.label ?? ""));
      return (
        <div data-testid="drive-content" data-view={viewMode} data-search={searchTerm} data-loading={String(isLoading)}>
          {filteredData.map((row) => (
            <div key={`${row.label}:${row.actualFileName}:${row.name}`} data-testid="drive-row">
              <span>{row.name}</span>
              <span data-testid="row-kind">{row.isDriveRoot ? "drive" : row.isFolder ? "folder" : "file"}</span>
              <span data-testid="row-location">{row.location ?? ""}</span>
              {row.isFolder ? <a href={route.folderHref?.(row) ?? ""}>Open {row.name}</a> : null}
              <button type="button" onClick={() => void toggleRow(row, "")}>
                Unstar {row.name}
              </button>
            </div>
          ))}
        </div>
      );
    },
  };
});
const viewPrefs = vi.hoisted(() => ({ saved: [] as string[], stored: "list" as "list" | "card" }));
vi.mock("@/app/lib/utils/userPreferencesDb", () => ({
  getViewModePreference: async () => viewPrefs.stored,
  saveViewModePreference: async (mode: string) => {
    viewPrefs.saved.push(mode);
  },
}));

const FILE_ID = "ab".repeat(32);

function item(overrides: Partial<StarredItem> = {}): StarredItem {
  const kind = overrides.kind ?? "file";
  const name = overrides.name ?? "plan.pdf";
  return {
    key:
      kind === "file"
        ? `5Me|0123456789abcdef|f:${overrides.fileId ?? FILE_ID}`
        : `5Me|0123456789abcdef|d:Work/${name}`,
    kind,
    ownerSs58: "5Me",
    folderHash: "0123456789abcdef",
    name,
    path: `Work/${name}`,
    fileId: kind === "file" ? FILE_ID : null,
    size: 2048,
    createdAt: 1_790_000_000,
    fileCount: null,
    isOwn: true,
    driveName: "Docs",
    location: "Docs / Work",
    openLabel: "Docs",
    openRemote: true,
    openName: null,
    openPath: "Work",
    uploadedBy: null,
    uploadedByName: null,
    arionCid: "",
    ...overrides,
  };
}

const SCOPE = { ownerSs58: "5Me", folderHash: "0123456789abcdef", rootPath: "" };

let listing: StarredListing | (() => never);

function renderView(syncedDrives: Record<string, string> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(queryClientAtom, queryClient);
  store.set(
    driveStatusesAtom,
    new Map(Object.entries(syncedDrives).map(([label, path]) => [label, { folderName: label, path, status: "active" } as never])),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <StarredView />
      </Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tauri.reset();
  push.mockClear();
  listing = { available: true, items: [] };
  tauri.onInvoke("list_starred", () => (typeof listing === "function" ? listing() : listing));
  tauri.onInvoke("star_scopes", () => ({ Docs: SCOPE }));
  viewPrefs.saved = [];
  searchParams = new URLSearchParams();
  viewPrefs.stored = "list";
  tauri.setInvokeFallback(() => null);
});

describe("StarredView", () => {
  it("says what goes here when nothing is starred", async () => {
    renderView();
    expect(screen.getByRole("heading", { name: "Starred" })).toBeTruthy();
    expect(screen.getByText("Files, folders and drives you starred")).toBeTruthy();
    expect(await screen.findByText("No starred items yet")).toBeTruthy();
    expect(screen.getByText("Star files, folders and drives to find them here.")).toBeTruthy();
  });

  it("says Starred is not available on an older server, with no error and no retry", async () => {
    listing = { available: false, items: [] };
    renderView();
    expect(await screen.findByText("Starred isn't available yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says the list could not be loaded, and Try again asks again", async () => {
    listing = () => {
      throw { kind: "Hcfs", message: "boom" };
    };
    renderView();
    expect(await screen.findByText("Couldn't load Starred.")).toBeTruthy();
    listing = { available: true, items: [item()] };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("plan.pdf")).toBeTruthy();
  });

  it("shows the starred items in the Drive's own view, as Drive rows", async () => {
    listing = {
      available: true,
      items: [
        item({ name: "a.pdf", fileId: "cd".repeat(32) }),
        item({ kind: "folder", name: "Taxes", path: "Work/Taxes", openPath: "Work/Taxes", size: 9 }),
        item({ kind: "drive", name: "Photos", path: "", location: "", openLabel: "Photos", openPath: "" }),
      ],
    };
    renderView();
    await screen.findByText("a.pdf");
    const rows = screen.getAllByTestId("drive-row");
    // Drives, then folders, then files, by name, until a column header sorts.
    expect(rows.map((r) => r.firstChild?.textContent)).toEqual(["Photos", "Taxes", "a.pdf"]);
    expect(screen.getAllByTestId("row-kind").map((k) => k.textContent)).toEqual(["drive", "folder", "file"]);
    expect(screen.getAllByTestId("row-location").map((k) => k.textContent)).toEqual(["", "Docs / Work", "Docs / Work"]);
    // No stats row: the search, the list/cards switch and refresh sit on the
    // title's line, and the rows right under it.
    expect(screen.queryByText("Total size:")).toBeNull();
    expect(screen.getByPlaceholderText("Search starred")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Card View" })).toBeTruthy();
  });

  it("opens a starred drive or folder right here, in its own drive", async () => {
    listing = {
      available: true,
      items: [
        item({ kind: "folder", name: "Taxes", openPath: "Work/Taxes" }),
        item({
          kind: "drive",
          name: "Team",
          path: "",
          location: "",
          openLabel: "shared:5O~0123456789abcdef",
          openName: "Team",
          openPath: "",
        }),
      ],
    };
    renderView();
    const folder = await screen.findByRole("link", { name: "Open Taxes" });
    expect(folder.getAttribute("href")).toBe("/starred?openLabel=Docs&openRemote=1&openSubfolder=Work%2FTaxes");
    const drive = screen.getByRole("link", { name: "Open Team" });
    expect(drive.getAttribute("href")).toBe("/starred?openLabel=shared%3A5O%7E0123456789abcdef&openRemote=1&openName=Team");
  });

  it("finds by every word of the search, in any order", async () => {
    listing = { available: true, items: [item({ name: "Q3 tax report.pdf" }), item({ name: "budget.xlsx", fileId: "cd".repeat(32) })] };
    renderView();
    await screen.findByText("budget.xlsx");
    fireEvent.change(screen.getByPlaceholderText("Search starred"), { target: { value: "report q3" } });
    await waitFor(() => expect(screen.queryByText("budget.xlsx")).toBeNull());
    expect(screen.getByText("Q3 tax report.pdf")).toBeTruthy();
    expect(screen.getByTestId("drive-content").getAttribute("data-search")).toBe("report q3");
  });

  it("switches between list and cards with the Drive's own switch, and keeps the choice", async () => {
    viewPrefs.stored = "card";
    listing = { available: true, items: [item()] };
    renderView();
    await screen.findByText("plan.pdf");
    // Opens the way the Drive last showed.
    await waitFor(() => expect(screen.getByTestId("drive-content").getAttribute("data-view")).toBe("card"));
    fireEvent.click(screen.getByRole("button", { name: "List View" }));
    expect(screen.getByTestId("drive-content").getAttribute("data-view")).toBe("list");
    expect(viewPrefs.saved).toEqual(["list"]);
  });

  it("drops an item at once when the Drive's menu unstars it", async () => {
    tauri.onInvoke("set_star", () => ({ key: `5Me|0123456789abcdef|f:${FILE_ID}`, favorite: false }));
    listing = { available: true, items: [item(), item({ name: "keep.pdf", fileId: "cd".repeat(32) })] };
    renderView();
    await screen.findByText("plan.pdf");
    // The scope resolves before the toggle can name the item by its key.
    await waitFor(() => expect(tauri.core.invoke.mock.calls.some(([cmd]) => cmd === "star_scopes")).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unstar plan.pdf" }));
    });
    await waitFor(() => expect(screen.queryByText("plan.pdf")).toBeNull());
    expect(screen.getByText("keep.pdf")).toBeTruthy();
  });

  it("shows an opened drive on this page, with Starred first in its trail", async () => {
    searchParams = new URLSearchParams({ openLabel: "Docs", openSubfolder: "Work/Taxes" });
    listing = { available: true, items: [item()] };
    renderView();
    const drive = await screen.findByTestId("drive-container");
    expect(drive.getAttribute("data-base")).toBe("/starred");
    expect(drive.getAttribute("data-parent")).toBe("/starred");
    expect(drive.textContent).toBe("Starred");
    // The list gives way to the drive.
    expect(screen.queryByTestId("drive-content")).toBeNull();
    expect(screen.queryByPlaceholderText("Search starred")).toBeNull();
  });
});

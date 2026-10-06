import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Alice" }) }));
// The global header reads staking and plan state; it has its own tests.
vi.mock("@/components/ui/page-header", () => ({
  default: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <header data-testid="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
// Capture's own buttons are pinned by CaptureButtons.test.tsx; here only
// where they appear matters.
vi.mock("@/app/components/capture/CaptureButtons", () => ({
  default: () => (
    <span data-testid="capture-buttons">
      <button type="button">Screenshot</button>
      <button type="button">Record</button>
    </span>
  ),
}));
// The drive is Drive's own container (paging, search, filters, views and row
// actions are pinned by its tests); the stub shows what it is pinned to.
vi.mock("@/app/components/page-sections/drive/DriveContainer", async () => {
  const { useDriveRoute } = await import("@/app/components/page-sections/drive/driveRoute");
  return {
    default: function DriveStub() {
      const route = useDriveRoute();
      return (
        <section
          data-testid="drive"
          data-base={route.basePath}
          data-label={route.pinned?.label}
          data-remote={String(route.pinned?.remote)}
        >
          {route.emptyState}
        </section>
      );
    },
  };
});

import CapturesView from "../CapturesView";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import type { CaptureDriveStatus } from "@/app/lib/tauri/capture";

const DOCS = { path: "/Users/a/Documents/Hippius Captures", place: "Documents › Hippius Captures", permissionNote: null };
const READY: CaptureDriveStatus = {
  state: "ready",
  label: "Hippius Captures",
  name: "Hippius Captures",
  remote: false,
  location: DOCS,
};

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <CapturesView />
      </Provider>
    </QueryClientProvider>,
  );
  return store;
}

beforeEach(() => {
  tauri.reset();
});

describe("the Captures page", () => {
  it("is titled Captures and shows a placeholder while it asks Rust", async () => {
    let answer: (v: unknown) => void = () => undefined;
    tauri.onInvoke("capture_drive_status", () => new Promise((resolve) => (answer = resolve)));
    renderView();
    expect(screen.getByRole("heading", { name: "Captures" })).toBeInTheDocument();
    expect(await screen.findByTestId("captures-loading")).toBeInTheDocument();
    await act(async () => answer(READY));
    expect(await screen.findByTestId("drive")).toBeInTheDocument();
  });

  // The captures drive is a drive: Drive's own container, pinned to it and
  // kept on this page, with the page's own empty state at its root.
  it("shows the captures drive through Drive's own container", async () => {
    tauri.onInvoke("capture_drive_status", () => READY);
    renderView();
    const drive = await screen.findByTestId("drive");
    expect(drive).toHaveAttribute("data-base", "/captures");
    expect(drive).toHaveAttribute("data-label", "Hippius Captures");
    expect(drive).toHaveAttribute("data-remote", "false");
    expect(within(drive).getByTestId("captures-empty")).toBeInTheDocument();
    // Screenshot and Record live in the drive's own toolbar, as on every
    // drive, so the page header does not repeat them.
    expect(within(screen.getByTestId("page-header")).queryByTestId("capture-buttons")).toBeNull();
  });

  it("browses a captures drive that is not synced here from the server", async () => {
    tauri.onInvoke("capture_drive_status", () => ({ ...READY, remote: true, location: null }));
    renderView();
    expect(await screen.findByTestId("drive")).toHaveAttribute("data-remote", "true");
  });

  it("before the drive exists, explains it and offers to capture or set it up", async () => {
    tauri.onInvoke("capture_drive_status", () => ({ state: "needsSetup", suggested: DOCS, waiting: 0 }));
    const store = renderView();
    const empty = await screen.findByTestId("captures-empty");
    expect(empty).toHaveTextContent("No captures yet");
    expect(empty).toHaveTextContent("Documents › Hippius Captures");
    expect(within(empty).getByTestId("capture-buttons")).toBeInTheDocument();
    expect(screen.queryByTestId("drive")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up the folder now" }));
    expect(store.get(captureDialogAtom)).toEqual({ kind: "captureDrive" });
  });

  it("says when captures are waiting on this computer", async () => {
    tauri.onInvoke("capture_drive_status", () => ({ state: "needsSetup", suggested: DOCS, waiting: 2 }));
    renderView();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "2 captures are kept on this computer until you set up your Captures folder.",
    );
  });

  it("says in Rust's words why a chosen folder has no drive yet, with Try again", async () => {
    tauri.onInvoke("capture_drive_status", () => ({
      state: "pending",
      location: DOCS,
      message: "Your captures are kept on this computer in Documents › Hippius Captures until Hippius can upload them.",
    }));
    const store = renderView();
    expect(await screen.findByRole("status")).toHaveTextContent("until Hippius can upload them.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(store.get(captureDialogAtom)).toEqual({ kind: "captureDrive" });
  });

  it("opens the drive as soon as Rust says it was set up", async () => {
    let status: CaptureDriveStatus = { state: "needsSetup", suggested: DOCS, waiting: 1 };
    tauri.onInvoke("capture_drive_status", () => status);
    renderView();
    await screen.findByTestId("captures-empty");
    status = READY;
    await act(() => tauri.emitEvent("capture_drive_changed", null));
    expect(await screen.findByTestId("drive")).toHaveAttribute("data-label", "Hippius Captures");
  });

  it("offers Try again when the status cannot be read", async () => {
    let fail = true;
    tauri.onInvoke("capture_drive_status", () => {
      if (fail) throw { kind: "Other", message: "db" };
      return READY;
    });
    renderView();
    expect(await screen.findByText("Couldn't load your captures right now.")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("drive")).toBeInTheDocument());
  });
});

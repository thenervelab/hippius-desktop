import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import FailedFilesModal from "../FailedFilesModal";
import { failedFilesAtom, type FailedFileInfo } from "@/lib/store/syncAtoms";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/FramedDialog", () => ({
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  default: () => null,
}));

const FILES: FailedFileInfo[] = [
  { label: "media", path: "Movies/Blade Runner [2049].mkv", fileName: "Blade Runner [2049].mkv", error: null, failureCount: 3 },
  { label: "media", path: "Shows/Ep 01.mp4", fileName: "Ep 01.mp4", error: "Server error (500).", failureCount: 3 },
];

function renderModal() {
  const store = createStore();
  store.set(failedFilesAtom, FILES);
  render(
    <Provider store={store}>
      <FailedFilesModal />
    </Provider>,
  );
  return store;
}

describe("FailedFilesModal", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  // Dismiss used to only clear the atom, so Rust re-opened the dialog every
  // third failing cycle and after every launch. It must tell Rust which files
  // the user has seen.
  it("Dismiss records every listed file in Rust and closes the dialog", async () => {
    const store = renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sp_dismiss_failed_files", {
        files: FILES.map(({ label, path }) => ({ label, path })),
      }),
    );
    expect(store.get(failedFilesAtom)).toBeNull();
  });
});

// State-machine coverage for `ShareFileModal`.
//
// The component fans out to three terminal states from a single async
// IPC call: `running → done` on success, `running → error` on failure,
// and the user can drive `error → running` via "Try again" or
// `done → closed` via "Revoke". Each transition is the seam where
// users have historically gotten stuck (frozen spinner, silent
// failure, double-revoke), so we cover all three.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
// Resolves to the mocked `Channel` class below — used as the constructor
// for `expect.any(Channel)` in the call assertions.
import { Channel } from "@tauri-apps/api/core";

import ShareFileModal from "../ShareFileModal";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";

// `invoke` is the only side effect the modal performs; mocking it
// gives us full control over which terminal state we land in.
const invokeMock = vi.fn();
// `createShare` opens a `Channel` for progress, so the mock module must
// expose a constructable `Channel`. The class is defined INLINE because
// `vi.mock` is hoisted above top-level declarations — referencing an
// outer `class` here throws "Cannot access before initialization". The
// stub mirrors the only bit the FE touches (a settable `onmessage`) and
// lets a test drive a progress update on the instance captured from
// `invokeMock`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));
// `openUrl` is a Tauri plugin; the modal calls it on "Open in browser"
// but we don't drive that path in these tests.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));
// `sonner.toast.*` is a fire-and-forget side effect for status feedback;
// stubbing it keeps the test environment quiet.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// `navigator.clipboard.writeText` is invoked on the `done` transition
// (auto-copy) and on Copy clicks. jsdom doesn't ship a clipboard, so
// we install a stub on the navigator before each test.
function installClipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return { writeText };
}

function withProvider(node: ReactNode, file: { actualFileName?: string; name: string; label: string }) {
  const store = createStore();
  // Modal reads the file from this atom — populating it is the same
  // signal a `setShareModalFile(file)` handler from the file-row
  // context menu would deliver in production.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.set(shareModalFileAtom, file as any);
  return <Provider store={store}>{node}</Provider>;
}

describe("ShareFileModal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    installClipboard();
  });

  it("shows running state then transitions to done with the share URL", async () => {
    invokeMock.mockResolvedValueOnce({
      shareToken: "tok-abc",
      shareUrl: "https://console.hippicode.com/share/tok-abc#k=KEY",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    // Running state shows the spinner copy first.
    expect(screen.getByText(/encrypting and uploading/i)).toBeInTheDocument();

    // Then the URL surfaces in the read-only textarea.
    const textarea = await screen.findByDisplayValue(/console\.hippicode\.com\/share\/tok-abc#k=KEY/);
    expect(textarea).toBeInTheDocument();
    // The third arg is the progress `Channel`; assert the file coordinates
    // without pinning the channel instance.
    expect(invokeMock).toHaveBeenCalledWith(
      "hcfs_create_share",
      expect.objectContaining({
        folderLabel: "Drive",
        relativePath: "doc.pdf",
        onProgress: expect.any(Channel),
      }),
    );
  });

  it("renders an indeterminate placeholder progress bar while running", async () => {
    // Hang the IPC so the modal stays in `running` long enough to inspect.
    invokeMock.mockReturnValueOnce(new Promise(() => {}));

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    const bar = await screen.findByRole("progressbar");
    // No backend progress yet, so the bar must be indeterminate — a
    // determinate `aria-valuenow` here would be a faked percentage.
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("flips the bar to determinate when a ShareProgress update arrives", async () => {
    // Hang the IPC so the modal stays in `running`; we drive progress
    // manually through the channel the modal opened.
    invokeMock.mockReturnValueOnce(new Promise(() => {}));

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    // Indeterminate until the first update lands.
    expect(await screen.findByRole("progressbar")).not.toHaveAttribute("aria-valuenow");

    // Grab the Channel the modal passed to `invoke` and push a 50%
    // uploading update, exactly as the Rust backend's `send` would.
    const args = invokeMock.mock.calls[0][1] as {
      onProgress: {
        onmessage:
          | ((m: { phase: string; bytesDone: number; bytesTotal: number }) => void)
          | null;
      };
    };
    act(() => {
      args.onProgress.onmessage?.({ phase: "uploading", bytesDone: 50, bytesTotal: 100 });
    });

    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText(/uploading/i)).toBeInTheDocument();
  });

  it("renders the error state when the IPC throws", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "Hcfs", message: "create_share: server unhappy" });

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    await waitFor(() => {
      expect(screen.getByText(/couldn.?t create share link/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/create_share: server unhappy/)).toBeInTheDocument();
    // "Try again" is the documented retry affordance.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("retries from the error state when 'Try again' is clicked", async () => {
    invokeMock
      .mockRejectedValueOnce("network down")
      .mockResolvedValueOnce({
        shareToken: "tok-xyz",
        shareUrl: "https://console.hippicode.com/share/tok-xyz#k=KEY2",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    await waitFor(() => {
      expect(screen.getByText(/couldn.?t create share link/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Second call succeeds; URL appears.
    await screen.findByDisplayValue(/console\.hippicode\.com\/share\/tok-xyz#k=KEY2/);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("calls hcfs_revoke_share when the user revokes from the done state", async () => {
    invokeMock
      .mockResolvedValueOnce({
        shareToken: "tok-rev",
        shareUrl: "https://console.hippicode.com/share/tok-rev#k=K",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .mockResolvedValueOnce(undefined); // revoke_share returns void

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    await screen.findByDisplayValue(/tok-rev/);

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("hcfs_revoke_share", { shareToken: "tok-rev" });
    });
  });
});

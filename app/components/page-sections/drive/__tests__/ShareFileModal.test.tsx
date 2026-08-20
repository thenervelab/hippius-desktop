// State-machine coverage for `ShareFileModal`.
//
// Both entry points now open on the chooser (expiry + public/password), then
// fan out to three terminal states from a single async IPC call: `running →
// done` on success, `running → error` on failure, and the user can drive
// `error → running` via "Try again" or `done → closed` via "Revoke". Each
// transition is the seam where users have historically gotten stuck (frozen
// spinner, silent failure, double-revoke), so we cover all three.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
// Resolves to the mocked `Channel` class below — used as the constructor
// for `expect.any(Channel)` in the call assertions.
import { Channel } from "@tauri-apps/api/core";

import ShareFileModal from "../ShareFileModal";
import {
  finderShareAtom,
  shareModalFileAtom,
  type FinderShareState,
} from "@/app/lib/global-atoms/sharesAtoms";

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
  // Modal reads the target from this atom — populating it is the same signal a
  // `setShareModalFile(shareTargetFor(file, base))` handler from the file-row
  // context menu delivers in production. The surface resolves `relativePath`,
  // so the fixture supplies it rather than the modal deriving it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.set(shareModalFileAtom, { file, relativePath: file.actualFileName || file.name } as any);
  return <Provider store={store}>{node}</Provider>;
}

// Seeds the Finder-driven atom in the `choosing` state — the same signal
// `FinderShareListener` delivers when it maps the backend's
// `finder:share-choosing` event. The modal then opens its public/private picker.
function withFinderState(node: ReactNode, share: FinderShareState) {
  const store = createStore();
  store.set(finderShareAtom, share);
  return <Provider store={store}>{node}</Provider>;
}

// A parked Finder request awaiting the user's visibility choice.
const CHOOSING: FinderShareState = { kind: "choosing", id: "req-1", name: "big-movie.mov" };

/**
 * Accept the chooser's defaults (public, 24h) and start the mint.
 *
 * Both entry points open on the chooser now, so every test that wants to reach
 * `running`/`done`/`error` goes through here first.
 */
function confirmChooser() {
  fireEvent.click(screen.getByRole("button", { name: /create share link/i }));
}

describe("ShareFileModal", () => {
  /**
   * REGRESSION: the modal is mounted permanently in the pages layout, so its
   * `useState` survives between shares. Before the chooser existed, the
   * auto-start effect reset state on every new file; when the chooser replaced
   * it, nothing did — so sharing a second file re-rendered straight into the
   * first file's `done` view, showing the wrong link.
   */
  it("starts a second share on the chooser, not the previous share's link", async () => {
    invokeMock.mockResolvedValue({
      shareToken: "tok-first",
      shareUrl: "https://console.hippius.com/share/tok-first#k=FIRST",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const store = createStore();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    store.set(shareModalFileAtom, {
      file: { name: "first.pdf", actualFileName: "first.pdf", label: "Drive" },
      relativePath: "first.pdf",
    } as any);
    render(
      <Provider store={store}>
        <ShareFileModal />
      </Provider>,
    );

    confirmChooser();
    await screen.findByDisplayValue(/tok-first#k=FIRST/);

    // Close the modal the way every dismiss path does, then open it for a
    // different file — exactly the sequence a user performs.
    act(() => {
      store.set(shareModalFileAtom, null as any);
    });
    act(() => {
      store.set(shareModalFileAtom, {
        file: { name: "second.pdf", actualFileName: "second.pdf", label: "Drive" },
        relativePath: "second.pdf",
      } as any);
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // The second share must begin at the chooser with nothing minted yet.
    expect(await screen.findByText(/general access/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/tok-first/)).not.toBeInTheDocument();
    expect(screen.getByText("second.pdf")).toBeInTheDocument();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    installClipboard();
  });

  it("shows running state then transitions to done with the share URL", async () => {
    invokeMock.mockResolvedValueOnce({
      shareToken: "tok-abc",
      shareUrl: "https://console.hippius.com/share/tok-abc#k=KEY",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

    // The in-app flow opens on the chooser, not a spinner — nothing is minted
    // until the user has picked an expiry and a visibility.
    expect(screen.getByText(/general access/i)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
    confirmChooser();

    // Running state shows the spinner copy next.
    expect(screen.getByText(/encrypting and uploading/i)).toBeInTheDocument();

    // Then the URL surfaces in the read-only textarea.
    const textarea = await screen.findByDisplayValue(/console\.hippius\.com\/share\/tok-abc#k=KEY/);
    expect(textarea).toBeInTheDocument();
    // The third arg is the progress `Channel`; assert the file coordinates
    // without pinning the channel instance.
    expect(invokeMock).toHaveBeenCalledWith(
      "hcfs_create_share",
      expect.objectContaining({
        folderLabel: "Drive",
        relativePath: "doc.pdf",
        ttl: "24h",
        visibility: "public",
        password: null,
        onProgress: expect.any(Channel),
      }),
    );
  });

  it("renders an indeterminate placeholder progress bar while running", async () => {
    // Hang the IPC so the modal stays in `running` long enough to inspect.
    invokeMock.mockReturnValueOnce(new Promise(() => {}));

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));
    confirmChooser();

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
    confirmChooser();

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
    confirmChooser();

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
        shareUrl: "https://console.hippius.com/share/tok-xyz#k=KEY2",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));
    confirmChooser();

    await waitFor(() => {
      expect(screen.getByText(/couldn.?t create share link/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Second call succeeds; URL appears.
    await screen.findByDisplayValue(/console\.hippius\.com\/share\/tok-xyz#k=KEY2/);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("opens into the visibility chooser (not a spinner) for a Finder request", async () => {
    // `finder:share-choosing` fires the instant a right-click is received —
    // before anything is minted. The modal must show the public/private picker,
    // NOT a spinner, and must not call any mint IPC until the user confirms.
    render(withFinderState(<ShareFileModal />, CHOOSING));

    expect(screen.getByText(/general access/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /anyone with the link/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /password protected/i })).toBeInTheDocument();
    expect(screen.getByText("big-movie.mov")).toBeInTheDocument();
    // Nothing minted yet, and never the in-app create path.
    expect(screen.queryByText(/encrypting and uploading/i)).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("hcfs_finder_confirm_share", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("hcfs_create_share", expect.anything());
  });

  it("confirms a public Finder share and shows the link without a password", async () => {
    const { writeText } = installClipboard();
    invokeMock.mockResolvedValueOnce({
      shareToken: "finder-tok",
      shareUrl: "https://console.hippius.com/share/finder-tok#k=FK",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    render(withFinderState(<ShareFileModal />, CHOOSING));

    // Default choice is public + 24h; confirm mints it.
    confirmChooser();

    await screen.findByDisplayValue(/share\/finder-tok#k=FK/);
    // The confirm IPC carries the parked id + chosen visibility + a progress Channel.
    expect(invokeMock).toHaveBeenCalledWith(
      "hcfs_finder_confirm_share",
      expect.objectContaining({
        requestId: "req-1",
        ttl: "24h",
        visibility: "public",
        password: null,
        onProgress: expect.any(Channel),
      }),
    );
    // Public link → no password field.
    expect(screen.queryByText(/send this password separately/i)).not.toBeInTheDocument();
    // Auto-copy runs for the minted link.
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://console.hippius.com/share/finder-tok#k=FK");
    });
  });

  it("confirms a password-protected Finder share and shows the generated password", async () => {
    installClipboard();
    // Switching to "Password protected" asks the backend for a default first,
    // then the confirm mints with it.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "hcfs_generate_share_password") {
        return Promise.resolve("s3cretPASSWORD123abc");
      }
      if (cmd === "hcfs_finder_confirm_share") {
        return Promise.resolve({
          shareToken: "priv-tok",
          shareUrl: "https://console.hippius.com/share/priv-tok#p=BLOB",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          password: "s3cretPASSWORD123abc",
        });
      }
      return Promise.resolve(undefined);
    });

    render(withFinderState(<ShareFileModal />, CHOOSING));

    // Switch to "Password protected"; the field pre-fills with the generated
    // password so the common path is strong without the user inventing one.
    fireEvent.click(screen.getByRole("button", { name: /password protected/i }));
    await screen.findByDisplayValue("s3cretPASSWORD123abc");

    confirmChooser();

    await screen.findByDisplayValue(/share\/priv-tok#p=BLOB/);
    expect(invokeMock).toHaveBeenCalledWith(
      "hcfs_finder_confirm_share",
      expect.objectContaining({
        requestId: "req-1",
        visibility: "private",
        password: "s3cretPASSWORD123abc",
      }),
    );
    // The password and its "send separately" guidance are shown.
    expect(screen.getByText(/send this password separately/i)).toBeInTheDocument();
  });

  it("sends the user's own password when they overwrite the generated one", async () => {
    installClipboard();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "hcfs_generate_share_password") return Promise.resolve("generated-one-here");
      if (cmd === "hcfs_finder_confirm_share") {
        return Promise.resolve({
          shareToken: "custom-tok",
          shareUrl: "https://console.hippius.com/share/custom-tok#p=B",
          expiresAt: null,
          password: "my own strong password",
        });
      }
      return Promise.resolve(undefined);
    });

    render(withFinderState(<ShareFileModal />, CHOOSING));
    fireEvent.click(screen.getByRole("button", { name: /password protected/i }));
    const field = await screen.findByDisplayValue("generated-one-here");

    fireEvent.change(field, { target: { value: "my own strong password" } });
    confirmChooser();

    await screen.findByDisplayValue(/share\/custom-tok#p=B/);
    expect(invokeMock).toHaveBeenCalledWith(
      "hcfs_finder_confirm_share",
      expect.objectContaining({ password: "my own strong password" }),
    );
  });

  it("blocks confirming while the typed password is too short", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "hcfs_generate_share_password"
        ? Promise.resolve("generated-one-here")
        : Promise.resolve(undefined),
    );

    render(withFinderState(<ShareFileModal />, CHOOSING));
    fireEvent.click(screen.getByRole("button", { name: /password protected/i }));
    const field = await screen.findByDisplayValue("generated-one-here");

    fireEvent.change(field, { target: { value: "short" } });

    expect(screen.getByRole("button", { name: /create share link/i })).toBeDisabled();
    confirmChooser();
    // Rust re-validates anyway, but the UI must not even attempt the mint.
    expect(invokeMock).not.toHaveBeenCalledWith("hcfs_finder_confirm_share", expect.anything());
  });

  it("passes the chosen expiry preset through to the mint", async () => {
    installClipboard();
    invokeMock.mockResolvedValueOnce({
      shareToken: "never-tok",
      shareUrl: "https://console.hippius.com/share/never-tok#k=K",
      expiresAt: null,
    });

    render(withFinderState(<ShareFileModal />, CHOOSING));

    // The expiry picker is the shared Radix `Select`: drive it entirely by
    // keyboard (open the trigger, Enter on the option) — jsdom has no real
    // pointer events, and Radix items select on Enter/Space.
    const trigger = screen.getByLabelText(/link expires/i);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(
      await screen.findByRole("option", { name: /until i revoke it/i }),
      { key: "Enter" },
    );
    confirmChooser();

    await screen.findByDisplayValue(/share\/never-tok#k=K/);
    expect(invokeMock).toHaveBeenCalledWith(
      "hcfs_finder_confirm_share",
      expect.objectContaining({ ttl: "never" }),
    );
    // A never-expiring link must not render a countdown line.
    expect(screen.queryByText(/^Expires /)).not.toBeInTheDocument();
  });

  it("cancels a Finder request without minting when the chooser is dismissed", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // cancel returns void
    render(withFinderState(<ShareFileModal />, CHOOSING));

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Cancel releases the parked request and never mints.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("hcfs_finder_cancel_share", { requestId: "req-1" });
    });
    expect(invokeMock).not.toHaveBeenCalledWith("hcfs_finder_confirm_share", expect.anything());
  });

  it("shows an error with no 'Try again' when a Finder confirm fails", async () => {
    // A failed confirm lands in the error state. The parked request was consumed
    // (single-use), so there is no in-app retry handle — only "Close" is offered.
    invokeMock.mockRejectedValueOnce({ kind: "NotReady", message: "Insufficient credits to create a share" });
    render(withFinderState(<ShareFileModal />, CHOOSING));

    confirmChooser();

    expect(await screen.findByText(/couldn.?t create share link/i)).toBeInTheDocument();
    expect(screen.getByText(/insufficient credits to create a share/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    // Still dismissible — the error body offers a Close action (the dialog's own
    // "X" also matches, so assert at least one Close affordance).
    expect(screen.getAllByRole("button", { name: /close/i }).length).toBeGreaterThan(0);
  });

  it("calls hcfs_revoke_share when the user revokes from the done state", async () => {
    invokeMock
      .mockResolvedValueOnce({
        shareToken: "tok-rev",
        shareUrl: "https://console.hippius.com/share/tok-rev#k=K",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .mockResolvedValueOnce(undefined); // revoke_share returns void

    render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));
    confirmChooser();

    await screen.findByDisplayValue(/tok-rev/);

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("hcfs_revoke_share", { shareToken: "tok-rev" });
    });
  });

  describe("folder shares", () => {
    // A folder opens the same modal, but the two mint commands are NOT
    // interchangeable: hcfs_create_share rejects a directory outright.
    const FOLDER = { name: "Photos", actualFileName: "Photos", label: "Drive", isFolder: true };

    /** Route the single invoke mock by command name, since a folder share
     *  makes two different calls (preflight, then mint). */
    function routeInvoke(preflight: unknown, mint?: unknown) {
      invokeMock.mockImplementation((command: string) => {
        if (command === "hcfs_folder_share_preflight") return Promise.resolve(preflight);
        return Promise.resolve(
          mint ?? {
            shareToken: "tok-folder",
            shareUrl: "https://console.hippius.com/share/tok-folder#k=K",
            expiresAt: null,
          },
        );
      });
    }

    const WITHIN_LIMITS = {
      totalBytes: 1_400_000_000,
      fileCount: 812,
      withinLimits: true,
      limitBytes: 2 * 1024 * 1024 * 1024,
      limitFiles: 10_000,
    };

    it("mints a folder through hcfs_create_folder_share, not the file command", async () => {
      routeInvoke(WITHIN_LIMITS);

      render(withProvider(<ShareFileModal />, FOLDER));
      await screen.findByText(/812 files/);
      confirmChooser();

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "hcfs_create_folder_share",
          expect.objectContaining({ folderLabel: "Drive", relativePath: "Photos" }),
        );
      });
      expect(invokeMock).not.toHaveBeenCalledWith("hcfs_create_share", expect.anything());
    });

    it("shows the folder's size and file count before minting", async () => {
      routeInvoke(WITHIN_LIMITS);

      render(withProvider(<ShareFileModal />, FOLDER));

      expect(await screen.findByText(/812 files/)).toBeInTheDocument();
      // SI units, matching the app-wide formatBytes and the backend cap message.
      expect(screen.getByText(/1\.4 GB/)).toBeInTheDocument();
    });

    it("disables minting when the backend reports the folder is over its limit", async () => {
      routeInvoke({
        totalBytes: 31_000_000_000,
        fileCount: 240_000,
        withinLimits: false,
        limitBytes: 2 * 1024 * 1024 * 1024,
        limitFiles: 10_000,
      });

      render(withProvider(<ShareFileModal />, FOLDER));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /create share link/i })).toBeDisabled();
      });
    });

    it("keeps minting available while the preflight is still in flight", async () => {
      // A slow stat must not block sharing a small folder; the Rust cap is the
      // real gate, and it re-checks on the mint.
      invokeMock.mockImplementation((command: string) =>
        command === "hcfs_folder_share_preflight" ? new Promise(() => {}) : Promise.resolve({}),
      );

      render(withProvider(<ShareFileModal />, FOLDER));

      expect(screen.getByRole("button", { name: /create share link/i })).toBeEnabled();
    });

    it("does not preflight a file", async () => {
      routeInvoke(WITHIN_LIMITS);

      render(withProvider(<ShareFileModal />, { name: "doc.pdf", actualFileName: "doc.pdf", label: "Drive" }));

      await screen.findByText(/general access/i);
      expect(invokeMock).not.toHaveBeenCalledWith("hcfs_folder_share_preflight", expect.anything());
    });
  });
});

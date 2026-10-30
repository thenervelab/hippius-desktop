// "Copy link" on a file menu copies the link the file already has and never
// makes one; locked, it unlocks first and copies after.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { FolderShareSummary, ShareSummary } from "@/app/lib/tauri/shares";
import { driveFolderHash } from "@/app/lib/utils/folderShareGating";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const unlock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/hooks/useUnlockFlow", () => ({ useUnlockFlow: () => ({ unlock, busy: false, isOAuth: true }) }));

import { useCopyLinkItem } from "../useCopyExistingLink";
import { LINK_ELSEWHERE_MESSAGE, UNLOCK_TO_COPY_LINK_LABEL } from "../existingLink";

const SHOT: FormattedUserFile = {
  name: "Screenshot 2026-10-30 at 11.58.27.png",
  actualFileName: "Screenshot 2026-10-30 at 11.58.27.png",
  label: "Captures",
  size: 100,
  isFolder: false,
} as FormattedUserFile;

const linkRow = (over: Partial<ShareSummary> = {}): ShareSummary =>
  ({
    shareToken: "tok",
    filename: SHOT.name,
    plaintextSize: 100,
    ciphertextSize: 100,
    mimeType: "image/png",
    createdAt: "2026-10-30T10:00:00Z",
    expiresAt: null,
    shareUrl: "https://console.hippius.com/s/tok#k=KEY",
    isPrivate: false,
    folderLabel: "Captures",
    relativePath: SHOT.name,
    ...over,
  }) as ShareSummary;

let listing: ShareSummary[] = [];
let folderListing: FolderShareSummary[] = [];
let writeText: ReturnType<typeof vi.fn>;

function setup({ locked = false }: { locked?: boolean } = {}) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { shares: true, folder_shares: true } as never);
  store.set(syncRequiresReauthAtom, locked);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useCopyLinkItem(), { wrapper });
  return { hook, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  listing = [];
  folderListing = [];
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "hcfs_list_shares" ? listing : cmd === "hcfs_list_folder_shares" ? folderListing : null,
  );
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

/** The commands that make a link. None of them may ever run from Copy link. */
const MINTING = ["hcfs_create_share", "hcfs_create_remote_share", "copy_file_share_link", "create_capture_link"];
const mintCalls = () => invoke.mock.calls.filter(([cmd]) => MINTING.includes(cmd as string));

describe("the Copy link menu item", () => {
  it("is not offered for a file with no link (Share via link is)", async () => {
    const { hook } = setup();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("hcfs_list_shares"));
    expect(hook.result.current(SHOT, SHOT.name)).toEqual([]);
  });

  it("is offered for a file with a live link, and copies it without making one", async () => {
    listing = [linkRow()];
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current(SHOT, SHOT.name)).toHaveLength(1));
    const [item] = hook.result.current(SHOT, SHOT.name);
    expect(item.itemTitle).toBe("Copy link");
    act(() => item.onItemClick?.());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://console.hippius.com/s/tok#k=KEY"));
    expect(toast.success).toHaveBeenCalledWith("Link copied", undefined);
    expect(mintCalls()).toEqual([]);
  });

  it("finds a capture's link made in the browser, as the row's link icon does", async () => {
    listing = [linkRow({ folderLabel: null, relativePath: null, shareUrl: "https://x/s/web#k=WEB" })];
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current(SHOT, SHOT.name)).toHaveLength(1));
    act(() => hook.result.current(SHOT, SHOT.name)[0].onItemClick?.());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://x/s/web#k=WEB"));
  });

  it("copies the newest of several links", async () => {
    listing = [
      linkRow({ shareToken: "a", createdAt: "2026-10-01T00:00:00Z", shareUrl: "https://x/s/a#k=A" }),
      linkRow({ shareToken: "b", createdAt: "2026-10-20T00:00:00Z", shareUrl: "https://x/s/b#k=B" }),
    ];
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current(SHOT, SHOT.name)).toHaveLength(1));
    act(() => hook.result.current(SHOT, SHOT.name)[0].onItemClick?.());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://x/s/b#k=B"));
  });

  it("says where to copy a link whose key is not on this computer, and copies nothing", async () => {
    listing = [linkRow({ shareUrl: null })];
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current(SHOT, SHOT.name)).toHaveLength(1));
    act(() => hook.result.current(SHOT, SHOT.name)[0].onItemClick?.());
    expect(toast).toHaveBeenCalledWith(LINK_ELSEWHERE_MESSAGE);
    expect(writeText).not.toHaveBeenCalled();
    expect(mintCalls()).toEqual([]);
  });

  it("locked, reads Unlock to copy link, and copies the link once the unlock dialog closes", async () => {
    listing = [linkRow({ shareUrl: null })];
    const { hook, store } = setup({ locked: true });
    await waitFor(() => expect(hook.result.current(SHOT, SHOT.name)).toHaveLength(1));
    const [item] = hook.result.current(SHOT, SHOT.name);
    expect(item.itemTitle).toBe(UNLOCK_TO_COPY_LINK_LABEL);

    // The unlock opens the recovery dialog.
    unlock.mockImplementation(async () => {
      store.set(activeRecoveryCheckAtom, { recommendedFlow: "unlock" } as never);
    });
    act(() => item.onItemClick?.());
    await waitFor(() => expect(unlock).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();

    // Unlocked: Rust can now open the owner wrap, so the listing has the key.
    listing = [linkRow({ shareUrl: "https://x/s/tok#k=BACK" })];
    act(() => {
      store.set(syncRequiresReauthAtom, false);
      store.set(activeRecoveryCheckAtom, null);
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://x/s/tok#k=BACK"));
    expect(mintCalls()).toEqual([]);
  });

  it("locked, copies nothing when the unlock is cancelled", async () => {
    listing = [linkRow({ shareUrl: null })];
    const { hook, store } = setup({ locked: true });
    await waitFor(() => expect(hook.result.current(SHOT, SHOT.name)).toHaveLength(1));
    unlock.mockImplementation(async () => {
      store.set(activeRecoveryCheckAtom, { recommendedFlow: "unlock" } as never);
    });
    act(() => hook.result.current(SHOT, SHOT.name)[0].onItemClick?.());
    await waitFor(() => expect(unlock).toHaveBeenCalled());
    act(() => store.set(activeRecoveryCheckAtom, null));
    await new Promise((r) => setTimeout(r, 20));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies a folder's live link from the folder-share listing", async () => {
    folderListing = [
      {
        tokenHash: "h1",
        folderHash: await driveFolderHash("Drive"),
        pathPrefix: "Trips/Photos",
        displayName: "Photos",
        createdAt: "2026-10-01T00:00:00Z",
        expiresAt: null,
        revokedAt: null,
        resolvable: true,
        shareToken: "ftok",
        shareUrl: "https://x/share/folder/ftok#s=SECRET",
        isPrivate: false,
        source: "drive",
        linkFormat: "linkSecret",
        reshareOffered: false,
      },
    ];
    const folder = { name: "Photos", actualFileName: "Photos", label: "Drive", isFolder: true } as FormattedUserFile;
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current(folder, "Trips/Photos")).toHaveLength(1));
    // Another folder of the same name elsewhere has no link.
    expect(hook.result.current(folder, "Photos")).toEqual([]);
    act(() => hook.result.current(folder, "Trips/Photos")[0].onItemClick?.());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://x/share/folder/ftok#s=SECRET"));
  });
});

// The viewer's Delete for a file browsed from the server (no copy on this
// computer): offered while the server has Trash, as Move to Trash; with
// Trash off it has none, as the Drive's menus.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { deleteRulesAtom } from "@/app/lib/trash/deleteMode";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/app/lib/capture/useCaptureAvailability", () => ({ useCaptureAvailability: () => "unavailable" }));
const openFileInEditor = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/lib/tauri/captureEditor", () => ({ openFileInEditor }));
const memberLabels = vi.hoisted(() => ({ set: new Set<string>() }));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({
  useMemberDriveLabels: () => memberLabels.set,
  useWritableMemberDriveLabels: () => new Set<string>(),
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Acct" }) }));
vi.mock("@/app/contexts/FileSelectionContext", () => ({ useFileSelection: () => ({ enterSelectionModeAndSelectFile: vi.fn() }) }));
vi.mock("../FileViewerThumbnailStrip", () => ({ default: () => null }));
vi.mock("../FileViewerTitle", () => ({ default: () => null }));
// The viewer's Copy link is covered by FileViewerLayoutCopyLink.test.tsx.
vi.mock("../../useExistingLinks", () => ({
  useExistingLinks: () => ({ linkFor: () => null, isLoadingFor: () => false }),
}));
vi.mock("../../useCopyExistingLink", () => ({ useCopyExistingLink: () => vi.fn() }));

import FileViewerLayout from "../FileViewerLayout";

const remoteFile = {
  name: "report.pdf",
  actualFileName: "Work/report.pdf",
  label: "archive",
  fileId: "ab".repeat(32),
  arionCid: "cid-1",
  isAssigned: true,
} as unknown as FormattedUserFile;

function show(trash: boolean) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { drive_trash: trash } as never);
  store.set(deleteRulesAtom, {
    address: "5Acct",
    skipTrash: false,
    drives: [{ label: "archive", canDeleteForever: true, skipsTrash: false }],
    at: Date.now(),
  });
  render(
    <Provider store={store}>
      <FileViewerLayout file={remoteFile} allFiles={[remoteFile]} onClose={() => {}} onNavigate={() => {}} handleFileDownload={() => {}}>
        <div />
      </FileViewerLayout>
    </Provider>,
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  memberLabels.set = new Set();
});

describe("the viewer's Delete on a file browsed from the server", () => {
  it("moves it to Trash while the server has Trash", () => {
    show(true);
    expect(screen.getByRole("button", { name: "Move to Trash" })).toBeInTheDocument();
  });

  it("is not offered with Trash off", () => {
    show(false);
    expect(screen.queryByRole("button", { name: "Delete file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to Trash" })).not.toBeInTheDocument();
  });
});

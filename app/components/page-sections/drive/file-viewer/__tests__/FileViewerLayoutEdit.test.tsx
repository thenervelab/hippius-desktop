// The viewer's top bar offers "Edit image" for the pictures the Drive row's
// menu offers it for, and opens the editor after closing itself.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

vi.mock("@/app/lib/featureFlags", async (orig) => ({ ...(await orig<object>()), SCREEN_CAPTURE_ENABLED: true }));
const openFileInEditor = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/lib/tauri/captureEditor", () => ({ openFileInEditor }));
const memberLabels = vi.hoisted(() => ({ set: new Set<string>() }));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({ useMemberDriveLabels: () => memberLabels.set }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Acct" }) }));
vi.mock("@/app/contexts/FileSelectionContext", () => ({ useFileSelection: () => ({ enterSelectionModeAndSelectFile: vi.fn() }) }));
vi.mock("../FileViewerThumbnailStrip", () => ({ default: () => null }));
vi.mock("../FileViewerTitle", () => ({ default: () => null }));

import FileViewerLayout from "../FileViewerLayout";

const picture = (over: Partial<FormattedUserFile> = {}) =>
  ({
    name: "Shot.png",
    actualFileName: "Captures/Shot.png",
    label: "Captures",
    source: "/Users/me/Hippius Captures/Shot.png",
    fileId: "f-1",
    arionCid: "cid-1",
    isAssigned: true,
    ...over,
  }) as unknown as FormattedUserFile;

function show(file: FormattedUserFile, onClose = vi.fn()) {
  render(
    <FileViewerLayout file={file} allFiles={[file]} onClose={onClose} onNavigate={() => {}} handleFileDownload={() => {}}>
      <div />
    </FileViewerLayout>,
  );
  return onClose;
}

beforeEach(() => {
  // jsdom has no scrolling; the dialog's scroll lock calls it.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  openFileInEditor.mockClear();
  memberLabels.set = new Set();
});

describe("the viewer's Edit image button", () => {
  it("opens the picture in the editor after closing the viewer", () => {
    const onClose = show(picture());
    fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
    expect(onClose).toHaveBeenCalled();
    expect(openFileInEditor).toHaveBeenCalledWith("Captures", "Captures/Shot.png", { fileId: "f-1", arionHash: "cid-1" });
  });

  it("is offered for a JPEG too", () => {
    show(picture({ name: "Photo.JPG", actualFileName: "Photos/Photo.JPG" }));
    expect(screen.getByRole("button", { name: "Edit image" })).toBeInTheDocument();
  });

  it("is not offered for a file the editor cannot save", () => {
    show(picture({ name: "Clip.mp4", actualFileName: "Captures/Clip.mp4" }));
    expect(screen.queryByRole("button", { name: "Edit image" })).not.toBeInTheDocument();
  });

  it("is not offered in a drive shared with this account", () => {
    memberLabels.set = new Set(["Captures"]);
    show(picture());
    expect(screen.queryByRole("button", { name: "Edit image" })).not.toBeInTheDocument();
  });
});

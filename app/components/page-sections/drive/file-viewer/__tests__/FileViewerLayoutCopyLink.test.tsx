// The viewer's top bar offers Copy link for a file that already has a live
// link, by the menus' own lookup, and nothing for one without.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";

vi.mock("@/app/lib/capture/useCaptureAvailability", () => ({ useCaptureAvailability: () => "unavailable" }));
vi.mock("@/app/lib/tauri/captureEditor", () => ({ openFileInEditor: vi.fn() }));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({ useMemberDriveLabels: () => new Set<string>() }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Acct" }) }));
vi.mock("@/app/contexts/FileSelectionContext", () => ({ useFileSelection: () => ({ enterSelectionModeAndSelectFile: vi.fn() }) }));
vi.mock("../FileViewerThumbnailStrip", () => ({ default: () => null }));
vi.mock("../FileViewerTitle", () => ({ default: () => null }));
const lookups = vi.hoisted(() => ({ linkFor: vi.fn() }));
vi.mock("../../useExistingLinks", () => ({
  useExistingLinks: () => ({ linkFor: lookups.linkFor, isLoadingFor: () => false }),
}));
const copy = vi.hoisted(() => vi.fn());
vi.mock("../../useCopyExistingLink", () => ({ useCopyExistingLink: () => copy }));

import FileViewerLayout from "../FileViewerLayout";

const FILE = {
  name: "Shot.png",
  actualFileName: "Captures/Shot.png",
  label: "Captures",
  source: "/x/Shot.png",
  syncStatus: "synced",
  isAssigned: true,
} as unknown as FormattedUserFile;

function show(onClose = vi.fn()) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { shares: true } as never);
  render(
    <Provider store={store}>
      <FileViewerLayout file={FILE} allFiles={[FILE]} onClose={onClose} onNavigate={() => {}} handleFileDownload={() => {}}>
        <div />
      </FileViewerLayout>
    </Provider>,
  );
  return onClose;
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  vi.clearAllMocks();
});

describe("the viewer's Copy link button", () => {
  it("is not offered for a file with no link", () => {
    lookups.linkFor.mockReturnValue(null);
    show();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share file" })).toBeInTheDocument();
  });

  it("copies the file's link and keeps the viewer open", () => {
    const link = { state: "ready", url: "https://x/s/t#k=K" };
    lookups.linkFor.mockReturnValue(link);
    const onClose = show();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(lookups.linkFor).toHaveBeenCalledWith(FILE, "Captures/Shot.png");
    expect(copy).toHaveBeenCalledWith(link, { file: FILE, relativePath: "Captures/Shot.png" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the viewer before an unlock, which opens over the page", () => {
    lookups.linkFor.mockReturnValue({ state: "locked", url: null });
    const onClose = show();
    fireEvent.click(screen.getByRole("button", { name: "Unlock to copy link" }));
    expect(onClose).toHaveBeenCalled();
    expect(copy).toHaveBeenCalled();
  });
});

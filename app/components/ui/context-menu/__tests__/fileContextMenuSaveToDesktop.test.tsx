// Right-click "Save to Desktop": a copy of the file on this computer, next to
// Reveal, through Rust (which checks the path is in a synced folder and picks
// a free name). Never offered for a folder or a file only on the server.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/lib/featureFlags", () => ({
  SHARED_DRIVES_ENABLED: true,
  FOLDER_ROLES_ENABLED: true,
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Me" }),
}));
vi.mock("@/app/utils/hooks/useUrlParams", () => ({
  useUrlParams: () => ({ getParam: () => null }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// "View insights" reads the share listing; these tests are about other items.
vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({
    getSharesFor: () => [],
    getUnplacedSharesNamed: () => [],
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));
vi.mock("@/app/components/page-sections/drive/useExistingLinks", () => ({
  useExistingLinks: () => ({ linkFor: () => null, isLoadingFor: () => false }),
}));
vi.mock("@/app/components/page-sections/drive/useCopyExistingLink", () => ({
  useCopyExistingLink: () => vi.fn(),
}));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks/useSharedDriveRoles")>();
  const empty = new Set<string>();
  return {
    ...actual,
    useMemberDriveLabels: () => empty,
    useWritableMemberDriveLabels: () => empty,
    useManageableMemberDriveLabels: () => empty,
  };
});

import FileContextMenu from "../index";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const shot = {
  name: "Screenshot 2026-11-02 at 10.00.00.png",
  actualFileName: "Screenshot 2026-11-02 at 10.00.00.png",
  isFolder: false,
  label: "Hippius Captures",
  source: "/Users/me/hippius-captures/Screenshot 2026-11-02 at 10.00.00.png",
} as FormattedUserFile;

function open(file: FormattedUserFile) {
  const onClose = vi.fn();
  render(
    <Provider store={createStore()}>
      <FileContextMenu x={10} y={10} file={file} onClose={onClose} onFileDownload={() => {}} basePath={null} />
    </Provider>,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("right-click Save to Desktop", () => {
  it("copies the file through Rust and says where it went", async () => {
    invoke.mockResolvedValue("Saved to your Desktop as Screenshot 2026-11-02 at 10.00.00.png.");
    const onClose = open(shot);
    fireEvent.click(await screen.findByText("Save to Desktop"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved to your Desktop as Screenshot 2026-11-02 at 10.00.00.png."),
    );
    expect(invoke).toHaveBeenCalledWith("save_file_to_desktop", { path: shot.source });
    expect(onClose).toHaveBeenCalled();
  });

  it("is not offered for a folder", async () => {
    open({ ...shot, name: "Trips", actualFileName: "Trips", isFolder: true } as FormattedUserFile);
    await screen.findByText(/Details/);
    expect(screen.queryByText("Save to Desktop")).toBeNull();
  });
});

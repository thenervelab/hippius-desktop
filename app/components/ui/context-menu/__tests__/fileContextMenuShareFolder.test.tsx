// Right-click "Share folder": it must open a FOLDER invite for the folder the
// user clicked. A folder row can carry only its basename, so the menu
// resolves the path against the view it was opened in; resolving against the
// drive root shared a same-named folder there instead.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

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
import {
  shareDialogAtom,
  serverCapabilitiesAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const nestedFolder = {
  name: "Photos",
  actualFileName: "Photos",
  isFolder: true,
  label: "mine",
} as FormattedUserFile;

function open(basePath: string | null) {
  const store = createStore();
  // Production today: folder grants off. Behind the flag the item is still
  // offered, and the server's refusal reads "coming soon".
  store.set(serverCapabilitiesAtom, {
    shares: true,
    folder_shares: true,
    folder_share_revoke_by_hash: true,
    share_owner_wrap: true,
    folder_grants: false,
  });
  render(
    <Provider store={store}>
      <FileContextMenu
        x={10}
        y={10}
        file={nestedFolder}
        onClose={() => {}}
        onFileDownload={() => {}}
        basePath={basePath}
      />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("right-click Share folder", () => {
  it("is offered behind the flag even while the server has folder grants off", async () => {
    open(null);
    expect(await screen.findByText("Share folder")).toBeInTheDocument();
  });

  it("opens a folder invite for the folder clicked, resolved against the open view", async () => {
    const store = open("Trips/2026");
    fireEvent.click(await screen.findByText("Share folder"));
    expect(store.get(shareDialogAtom)).toEqual({
      label: "mine",
      folderName: "Photos",
      pathPrefix: "Trips/2026/Photos",
    });
  });
});

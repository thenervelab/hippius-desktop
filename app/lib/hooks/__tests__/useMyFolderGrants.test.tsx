// @vitest-environment jsdom
// Folder grants held by this account (folder roles, staging only): fetched
// only with the flag AND the server capability, and found by `grant:` label.
import React, { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";

const listMyFolderGrantsMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...actual,
    listMyFolderGrants: () => listMyFolderGrantsMock(),
    listMyDriveMemberships: () => Promise.resolve([]),
  };
});
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  SHARED_DRIVES_ENABLED: true,
  get FOLDER_ROLES_ENABLED() {
    return flag.on;
  },
}));

import {
  useFolderGrantForLabel,
  useWritableMemberDriveLabels,
} from "@/app/lib/hooks/useSharedDriveRoles";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { makeFolderGrantLabel } from "@/app/lib/shared-drives/sharedDriveLabel";

const GRANT = {
  ownerSs58: "5Owner",
  folderHash: "abc",
  displayLabel: "Team",
  pathPrefix: "Clients/ACME",
  role: "writer",
  createdAt: "",
};

function wrapper(roles: boolean) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, {
    shares: true,
    folder_shares: true,
    folder_share_revoke_by_hash: true,
    share_owner_wrap: true,
    folder_grants: true,
    folder_grant_roles: roles,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = true;
  listMyFolderGrantsMock.mockResolvedValue([GRANT]);
});

describe("useFolderGrantForLabel", () => {
  it("finds the grant a grant: label names", async () => {
    const label = makeFolderGrantLabel(GRANT);
    const { result } = renderHook(() => useFolderGrantForLabel(label), { wrapper: wrapper(true) });
    await waitFor(() => expect(result.current.grant?.role).toBe("writer"));
    expect(result.current.isGrant).toBe(true);
  });

  it("is not a grant for an ordinary label", () => {
    const { result } = renderHook(() => useFolderGrantForLabel("team-docs"), { wrapper: wrapper(true) });
    expect(result.current.isGrant).toBe(false);
  });

  it("fetches nothing on a server without folder roles", async () => {
    const { result } = renderHook(() => useWritableMemberDriveLabels(), { wrapper: wrapper(false) });
    await new Promise((r) => setTimeout(r, 0));
    expect(listMyFolderGrantsMock).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("fetches nothing with the lane flag off", async () => {
    flag.on = false;
    renderHook(() => useWritableMemberDriveLabels(), { wrapper: wrapper(true) });
    await new Promise((r) => setTimeout(r, 0));
    expect(listMyFolderGrantsMock).not.toHaveBeenCalled();
  });

  it("makes a writable grant's label writable", async () => {
    const { result } = renderHook(() => useWritableMemberDriveLabels(), { wrapper: wrapper(true) });
    await waitFor(() => expect(result.current.has(makeFolderGrantLabel(GRANT))).toBe(true));
  });
});

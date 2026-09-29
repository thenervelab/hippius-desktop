// @vitest-environment jsdom
// A role chip belongs to the thing access was granted on: the drive (its
// Shared with me row, its drive list row, the header you see once inside),
// or a folder held on its own (its Shared with me entry). A folder row
// INSIDE a drive never repeats the drive's role. The reported case is a
// Manager opening a drive that holds a folder with the drive's own name,
// where the folder row must not say "Manager" too.
//
// The row renders its real sharing marks here (only the link badge and the
// router are stubbed), so a role chip added anywhere in the folder row's
// suffix fails this file.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";

const listMyDriveMembershipsMock = vi.hoisted(() => vi.fn());
const listOwnedFolderSharingMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...actual,
    listMyDriveMemberships: () => listMyDriveMembershipsMock(),
    listOwnedFolderSharing: (...a: unknown[]) =>
      listOwnedFolderSharingMock(...a),
  };
});

vi.mock("@/app/lib/featureFlags", () => ({
  SHARED_DRIVES_ENABLED: true,
  FOLDER_ROLES_ENABLED: true,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string | { pathname: string };
  }) => (
    <a href={typeof href === "string" ? href : href.pathname}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/utils/hooks/useUrlParams", () => ({
  useUrlParams: () => ({
    getParam: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock("@/components/page-sections/drive/SharedLinkBadge", () => ({
  default: () => null,
}));

vi.mock("@/components/ui/MiddleTruncatedName", () => ({
  default: ({ name, suffix }: { name: string; suffix?: React.ReactNode }) => (
    <span>
      {name}
      {suffix}
    </span>
  ),
}));

import NameCell from "../NameCell";

const ROLE_WORDS = /\b(Manager|Editor|Viewer)\b/;

function membership(role: string) {
  return {
    ownerSs58: "5Owner",
    folderHash: "abc",
    displayLabel: "team",
    role,
    createdAt: "",
    syncedLocally: true,
    localLabel: "team",
  };
}

function renderFolderRow(name: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Provider store={createStore()}>
        <NameCell
          rawName={name}
          actualName={name}
          arionHash="0xfolder"
          isAssigned
          isFolder
          label="team"
        />
      </Provider>
    </QueryClientProvider>,
  );
}

async function settle() {
  await waitFor(() => expect(listMyDriveMembershipsMock).toHaveBeenCalled());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listMyDriveMembershipsMock.mockResolvedValue([]);
  listOwnedFolderSharingMock.mockResolvedValue([
    { path: "team", holderCount: 2, hasInvite: false },
  ]);
});

describe("role chips on folder rows inside a drive", () => {
  it.each(["manager", "writer", "reader"])(
    "a whole-drive %s sees no role chip on a folder named like the drive",
    async (role) => {
      listMyDriveMembershipsMock.mockResolvedValue([membership(role)]);
      renderFolderRow("team");
      await settle();

      expect(screen.getByText("team")).toBeInTheDocument();
      expect(screen.queryByText(ROLE_WORDS)).not.toBeInTheDocument();
    },
  );

  // The control: the owner's row does draw its folder mark in this harness,
  // so the absence above is the rule and not a row that never renders marks.
  // The owner's mark is a count of people, never a role.
  it("an owner sees the folder's own sharing count, and no role chip", async () => {
    renderFolderRow("team");

    expect(await screen.findByText("Shared with 2")).toBeInTheDocument();
    expect(screen.queryByText(ROLE_WORDS)).not.toBeInTheDocument();
  });
});

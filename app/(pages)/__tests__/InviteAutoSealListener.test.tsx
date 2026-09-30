// Coverage for `InviteAutoSealListener`: Rust delivers emailed invitation
// keys on its own and reports each one with `shared-drive:invite-key-delivered`.
// This is the only place the owner learns it happened, and the only thing that
// moves an open list's row from "Opened" to "Approved", so a broken map here is
// a delivery nobody sees.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import InviteAutoSealListener, { inviteKeyDeliveredMessage } from "../InviteAutoSealListener";
import {
  driveInvitesVersionAtom,
  inviteKeyDeliveredVersionAtom,
} from "@/app/lib/global-atoms/sharesAtoms";

const listenHandlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(() => listenHandlers.delete(event));
  }),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));

const flags = vi.hoisted(() => ({ sharedDrives: true, folderRoles: false }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flags.sharedDrives;
  },
  get FOLDER_ROLES_ENABLED() {
    return flags.folderRoles;
  },
}));

const startMock = vi.fn();
const stopMock = vi.fn();
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    startInviteAutoSeal: (...a: unknown[]) => Promise.resolve(startMock(...a)),
    stopInviteAutoSeal: (...a: unknown[]) => Promise.resolve(stopMock(...a)),
  };
});

const EVENT = "shared-drive:invite-key-delivered";

function renderListener() {
  const store = createStore();
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <InviteAutoSealListener />
      </Provider>
    </QueryClientProvider>,
  );
  return { store, invalidate, unmount };
}

describe("InviteAutoSealListener", () => {
  beforeEach(() => {
    listenHandlers.clear();
    vi.clearAllMocks();
    flags.sharedDrives = true;
    flags.folderRoles = false;
  });

  it("starts delivery with the folder flag and stops it on unmount", async () => {
    flags.folderRoles = true;
    const { unmount } = renderListener();
    await waitFor(() => expect(listenHandlers.has(EVENT)).toBe(true));
    expect(startMock).toHaveBeenCalledWith(true);
    unmount();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing while shared drives are off", async () => {
    flags.sharedDrives = false;
    renderListener();
    await new Promise((r) => setTimeout(r, 0));
    expect(startMock).not.toHaveBeenCalled();
    expect(listenHandlers.has(EVENT)).toBe(false);
  });

  it("toasts the delivery and refreshes every list that shows the invitation", async () => {
    const { store, invalidate } = renderListener();
    await waitFor(() => expect(listenHandlers.has(EVENT)).toBe(true));

    listenHandlers.get(EVENT)!({
      payload: { label: "Team", folderHash: "fh", inviteId: "i1", recipientEmail: "ada@example.com" },
    });

    expect(toastSuccess).toHaveBeenCalledWith("ada@example.com can join Team.");
    expect(store.get(inviteKeyDeliveredVersionAtom)).toBe(1);
    expect(store.get(driveInvitesVersionAtom)).toBe(1);
    expect(invalidate).toHaveBeenCalled();
  });

  it("says Someone when the address is hidden", () => {
    expect(inviteKeyDeliveredMessage({ label: "Team", folderHash: "fh", inviteId: "i" })).toBe(
      "Someone can join Team.",
    );
    expect(
      inviteKeyDeliveredMessage({ label: "Team", folderHash: "fh", inviteId: "i", recipientEmail: "  " }),
    ).toBe("Someone can join Team.");
  });
});

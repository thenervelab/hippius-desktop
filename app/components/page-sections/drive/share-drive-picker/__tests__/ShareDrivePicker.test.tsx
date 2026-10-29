import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import "@testing-library/jest-dom";

import { shareDialogAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { BILLING_ROUTE } from "@/app/lib/routes";

const plan = vi.hoisted(() => ({ allows: true as boolean | undefined }));
vi.mock("@/app/lib/hooks/useSharedDrivesInPlan", () => ({
  useSharedDrivesInPlan: () => plan.allows,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Grwva" }),
}));
// The one IPC the New drive step calls. Rust names and checks the drive;
// here it answers as Rust would.
const createCloudDrive = vi.hoisted(() =>
  vi.fn(async (_account: string, name: string) => ({ label: name.trim(), folderHash: "0123456789abcdef" })),
);
vi.mock("@/app/lib/tauri/syncFolders", () => ({ createCloudDrive }));

import ShareDriveFlow from "../ShareDriveFlow";
import {
  driveSharingMeta,
  filterDrives,
  selectedDrive,
} from "../shareDrivePickerState";

const sharing = (memberCount: number, totalInviteCount = 0): DriveSharing => ({
  memberCount,
  liveInviteCount: totalInviteCount,
  totalInviteCount,
});

function renderFlow(
  props: Partial<React.ComponentProps<typeof ShareDriveFlow>> = {},
) {
  const store = createStore();
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <ShareDriveFlow
        drives={["Photos", "Work"]}
        sharingByLabel={new Map([["Work", sharing(3)], ["Photos", sharing(0)]])}
        loading={false}
        onClose={onClose}
        {...props}
      />
    </Provider>,
  );
  return { store, onClose };
}

beforeEach(() => {
  plan.allows = true;
  push.mockReset();
  createCloudDrive.mockClear();
});

describe("picker rules", () => {
  it("words a drive's sharing, and says nothing while it is unknown", () => {
    expect(driveSharingMeta(sharing(4))).toBe("Shared with 4");
    expect(driveSharingMeta(sharing(0, 2))).toBe("Shared");
    expect(driveSharingMeta(sharing(0))).toBe("Not shared");
    expect(driveSharingMeta(undefined)).toBeNull();
  });

  it("searches by name and never keeps a pick the search hid", () => {
    expect(filterDrives(["Photos", "Work"], " wo ")).toEqual(["Work"]);
    expect(filterDrives(["Photos", "Work"], "")).toEqual(["Photos", "Work"]);
    expect(selectedDrive(["Photos", "Work"], "Work")).toBe("Work");
    expect(selectedDrive(["Work"], "Photos")).toBe("Work");
    expect(selectedDrive([], "Photos")).toBeNull();
  });
});

describe("Share a drive picker", () => {
  it("lists your drives with their sharing and opens the Share dialog for the one chosen", () => {
    const { store, onClose } = renderFlow();
    expect(screen.getByText("Share a drive")).toBeInTheDocument();
    expect(screen.getByText("Choose which of your drives to share")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Your drives" });
    expect(within(group).getByText("Shared with 3")).toBeInTheDocument();
    expect(within(group).getByText("Not shared")).toBeInTheDocument();
    // The first is chosen until another is picked.
    expect(screen.getByRole("radio", { name: /Photos/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /Work/ }));
    expect(screen.getByRole("radio", { name: /Work/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // The picker closes first, then the Share dialog opens: one at a time.
    expect(onClose).toHaveBeenCalled();
    expect(store.get(shareDialogAtom)).toEqual({ label: "Work", folderName: "Work" });
  });

  it("moves the choice with the arrow keys", () => {
    renderFlow();
    const photos = screen.getByRole("radio", { name: /Photos/ });
    fireEvent.keyDown(photos, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /Work/ })).toHaveAttribute("aria-checked", "true");
  });

  it("offers search only above six drives", () => {
    renderFlow();
    expect(screen.queryByPlaceholderText("Search your drives")).not.toBeInTheDocument();
  });

  it("searches a long list", () => {
    const drives = ["A1", "A2", "A3", "A4", "A5", "A6", "Budget"];
    renderFlow({ drives, sharingByLabel: new Map() });
    const search = screen.getByPlaceholderText("Search your drives");
    fireEvent.change(search, { target: { value: "bud" } });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Budget/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByRole("status")).toHaveTextContent("No drives match");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("on Free or Starter shows the upgrade card and Upgrade plan instead of Continue", () => {
    plan.allows = false;
    const { store, onClose } = renderFlow();
    expect(screen.getByRole("region", { name: "Upgrade to share" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
    expect(store.get(shareDialogAtom)).toBeNull();
  });

  it("with no drive of your own offers to make one right here, never to sync a folder", () => {
    const { onClose } = renderFlow({ drives: [], sharingByLabel: new Map() });
    expect(screen.getByText("You don't have a drive yet")).toBeInTheDocument();
    expect(screen.getByText("Make one here, then choose who to share it with.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync a Folder/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New drive" }));
    // A step in the same dialog: nothing closed, a name field instead.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Drive name")).toHaveFocus();
  });

  it("with no drive on a plan that cannot share, says so instead of offering one", () => {
    plan.allows = false;
    renderFlow({ drives: [], sharingByLabel: new Map() });
    expect(screen.getByText("You don't have a drive yet")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Upgrade to share" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync a Folder/ })).not.toBeInTheDocument();
  });

  it("shows skeletons while the drives or the plan load, never the empty line", () => {
    plan.allows = undefined;
    renderFlow({ drives: [] });
    expect(screen.getByLabelText("Loading your drives")).toBeInTheDocument();
    expect(screen.queryByText("You don't have a drive yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Upgrade to share" })).not.toBeInTheDocument();
  });

  it("Cancel closes without opening anything", () => {
    const { store, onClose } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(store.get(shareDialogAtom)).toBeNull();
  });

  it("offers New drive beside the search, after it in tab order, and before the list", () => {
    const drives = ["A1", "A2", "A3", "A4", "A5", "A6", "Budget"];
    const { onClose, store } = renderFlow({ drives, sharingByLabel: new Map() });
    const toolbar = screen.getByTestId("picker-toolbar");
    const search = within(toolbar).getByPlaceholderText("Search your drives");
    const newDrive = within(toolbar).getByRole("button", { name: "New drive" });
    // One row from `sm`, stacked full width below it.
    expect(toolbar).toHaveClass("flex-col", "sm:flex-row");
    expect(newDrive).toHaveClass("w-full", "sm:w-auto", "h-8");
    // The field, then the button, then the drives.
    expect(search.compareDocumentPosition(newDrive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Your drives" });
    expect(newDrive.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(newDrive);
    // The name step replaces the list inside the same dialog.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Drive name")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(store.get(shareDialogAtom)).toBeNull();
  });

  it("keeps New drive on its own at the right of the row when there is no search", () => {
    renderFlow();
    expect(screen.queryByPlaceholderText("Search your drives")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New drive" })).toHaveClass("sm:ml-auto");
  });

  it("offers no New drive on a plan that cannot share", () => {
    plan.allows = false;
    renderFlow();
    expect(screen.queryByRole("button", { name: "New drive" })).not.toBeInTheDocument();
  });

  it("offers no New drive before the drives load", () => {
    renderFlow({ loading: true });
    expect(screen.queryByRole("button", { name: "New drive" })).not.toBeInTheDocument();
  });


  it("gives the list's scrollbar a lane of its own beside the rows", () => {
    renderFlow();
    const group = screen.getByRole("radiogroup", { name: "Your drives" });
    // `scroll-gutter` styles the scrollbar so it is never an overlay, and the
    // padding plus the negative margin put that lane in the dialog's side
    // padding, so the rows line up with the field above and never sit under it.
    expect(group).toHaveClass("scroll-gutter", "overflow-y-auto", "pr-1.5", "-mr-3.5");
  });
});


describe("the New drive step", () => {
  const openStep = (props: Partial<React.ComponentProps<typeof ShareDriveFlow>> = {}) => {
    const rendered = renderFlow(props);
    fireEvent.click(screen.getByRole("button", { name: "New drive" }));
    return rendered;
  };

  it("names the drive, makes it on Hippius, then opens its Share dialog with nothing in between", async () => {
    const { store, onClose } = openStep();
    expect(screen.getByText("Give it a name. You'll choose who to share it with next.")).toBeInTheDocument();
    // Said plainly: no folder on this computer is involved.
    expect(screen.getByText(/It lives on Hippius, not on this computer/)).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create drive" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "  Launch " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create drive" }));
    });

    expect(createCloudDrive).toHaveBeenCalledTimes(1);
    expect(createCloudDrive).toHaveBeenCalledWith("5Grwva", "Launch");
    // The picker closes, then the Share dialog opens for the drive Rust made.
    expect(onClose).toHaveBeenCalled();
    expect(store.get(shareDialogAtom)).toEqual({ label: "Launch", folderName: "Launch" });
    // Every drive list is told, so the drive shows up as not synced here.
    expect(store.get(triggerSyncPathRefreshAtom)).toBe(1);
  });

  it("also creates on Enter, once however often it repeats", async () => {
    openStep();
    const field = screen.getByLabelText("Drive name");
    fireEvent.change(field, { target: { value: "Launch" } });
    await act(async () => {
      fireEvent.submit(field.closest("form")!);
      fireEvent.submit(field.closest("form")!);
    });
    expect(createCloudDrive).toHaveBeenCalledTimes(1);
  });

  it("shows Rust's refusal under the field and stays on the step with the name kept", async () => {
    createCloudDrive.mockRejectedValueOnce({
      kind: "Validation",
      message: "You already have a drive called \u201cLaunch\u201d. Choose another name.",
    });
    const { store, onClose } = openStep();
    const field = screen.getByLabelText("Drive name");
    fireEvent.change(field, { target: { value: "Launch" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create drive" }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent("You already have a drive called \u201cLaunch\u201d.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveValue("Launch");
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(shareDialogAtom)).toBeNull();
    // A new name clears the old sentence, and the create can be tried again.
    fireEvent.change(field, { target: { value: "Launch 2" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create drive" }));
    });
    expect(createCloudDrive).toHaveBeenCalledTimes(2);
    expect(store.get(shareDialogAtom)).toEqual({ label: "Launch 2", folderName: "Launch 2" });
  });

  it("words an offline failure the way Rust sent it", async () => {
    createCloudDrive.mockRejectedValueOnce({
      kind: "Other",
      message: "Couldn't reach Hippius, so the drive wasn't created. Try again in a moment.",
    });
    openStep();
    fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "Launch" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create drive" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach Hippius");
  });

  it("holds the dialog while the drive is being made", async () => {
    let finish: (v: { label: string; folderHash: string }) => void = () => {};
    createCloudDrive.mockImplementationOnce(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { store, onClose } = openStep();
    fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create drive" }));

    expect(await screen.findByRole("button", { name: /Creating drive/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Back/ })).toBeDisabled();
    expect(screen.getByLabelText("Drive name")).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Drive name"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Drive name")).toBeInTheDocument();

    await act(async () => finish({ label: "Launch", folderHash: "0123456789abcdef" }));
    expect(store.get(shareDialogAtom)).toEqual({ label: "Launch", folderName: "Launch" });
  });

  it("Back and Escape return to the list with focus on New drive, and nothing is made", async () => {
    const { onClose } = openStep();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("radiogroup", { name: "Your drives" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "New drive" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "New drive" }));
    fireEvent.keyDown(screen.getByLabelText("Drive name"), { key: "Escape" });
    expect(screen.getByRole("radiogroup", { name: "Your drives" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(createCloudDrive).not.toHaveBeenCalled();
  });

  it("raises no Share dialog for a create that lands after the picker went away", async () => {
    let finish: (v: { label: string; folderHash: string }) => void = () => {};
    createCloudDrive.mockImplementationOnce(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const store = createStore();
    const { unmount } = render(
      <Provider store={store}>
        <ShareDriveFlow drives={["Photos"]} sharingByLabel={new Map()} loading={false} onClose={vi.fn()} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New drive" }));
    fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create drive" }));
    unmount();
    await act(async () => finish({ label: "Launch", folderHash: "0123456789abcdef" }));
    expect(store.get(shareDialogAtom)).toBeNull();
  });
});

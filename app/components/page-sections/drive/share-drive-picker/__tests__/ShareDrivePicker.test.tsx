import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import "@testing-library/jest-dom";

import { shareDialogAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { BILLING_ROUTE } from "@/app/lib/routes";

const plan = vi.hoisted(() => ({ allows: true as boolean | undefined }));
vi.mock("@/app/lib/hooks/useSharedDrivesInPlan", () => ({
  useSharedDrivesInPlan: () => plan.allows,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

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
  const onAddDrive = vi.fn();
  render(
    <Provider store={store}>
      <ShareDriveFlow
        drives={["Photos", "Work"]}
        sharingByLabel={new Map([["Work", sharing(3)], ["Photos", sharing(0)]])}
        loading={false}
        onClose={onClose}
        onAddDrive={onAddDrive}
        {...props}
      />
    </Provider>,
  );
  return { store, onClose, onAddDrive };
}

beforeEach(() => {
  plan.allows = true;
  push.mockReset();
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

  it("with no drive of your own offers to make one", () => {
    const { onAddDrive, onClose } = renderFlow({ drives: [], sharingByLabel: new Map() });
    expect(screen.getByText("You don't have a drive yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync a Folder" }));
    expect(onClose).toHaveBeenCalled();
    expect(onAddDrive).toHaveBeenCalled();
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
});

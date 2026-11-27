// Deleting a whole drive is permanent: Hippius Trash takes what is inside a
// drive, never the drive. While the server has Trash the dialog says so
// first; with Trash off its words are today's.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { DeleteServerDialog } from "../DeleteServerDialog";
import { deleteDriveCopy } from "../deleteDriveCopy";

function renderDialog(trash: boolean, confirmInput = "") {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { drive_trash: trash } as never);
  const onConfirm = vi.fn();
  render(
    <Provider store={store}>
      <DeleteServerDialog
        open
        folderName="Documents"
        confirmInput={confirmInput}
        isDeletingServer={false}
        onConfirmInputChange={() => {}}
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    </Provider>,
  );
  return onConfirm;
}

describe("Delete a drive from Hippius", () => {
  it("says plainly that a drive does not go to Trash while the server has one", () => {
    renderDialog(true);
    expect(screen.getByText("Delete Drive Forever")).toBeInTheDocument();
    expect(screen.getByText(/Drives don't go to Trash\. This deletes every file in/)).toBeInTheDocument();
    expect(screen.getByText(/for good\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Forever" })).toBeDisabled();
  });

  it("keeps the typed confirmation", () => {
    const onConfirm = renderDialog(true, "Documents");
    fireEvent.click(screen.getByRole("button", { name: "Delete Forever" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps today's words with Trash off", () => {
    renderDialog(false);
    expect(screen.getByText("Delete Folder from Server")).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete all files for/)).toBeInTheDocument();
    expect(screen.queryByText(/Trash/)).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Permanently" })).toBeInTheDocument();
  });

  it("is one short sentence pair, no helper paragraph", () => {
    const copy = deleteDriveCopy(true);
    const words = `${copy.lead}"Documents"${copy.tail}`;
    expect(words).toBe('Drives don\'t go to Trash. This deletes every file in "Documents" for good.');
  });
});

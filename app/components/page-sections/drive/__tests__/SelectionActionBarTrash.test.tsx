import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { deleteRulesAtom } from "@/app/lib/trash/deleteMode";

const h = vi.hoisted(() => ({ selected: [] as FormattedUserFile[], clear: vi.fn() }));
vi.mock("@/app/contexts/FileSelectionContext", () => ({
  useFileSelection: () => ({ isSelectionMode: true, selectedFiles: h.selected, clearSelection: h.clear }),
}));
vi.mock("../useCaptureInsightsItem", () => ({ useCaptureLinkTokens: () => () => [] }));
vi.mock("../move/DriveMoveProvider", () => ({ useDriveMove: () => null }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Me" }),
}));
vi.mock("@/app/lib/capture/shortcutLabel", () => ({ isMacPlatform: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import SelectionActionBar from "../SelectionActionBar";

const FILE = { name: "a.txt", actualFileName: "a.txt" } as FormattedUserFile;

function renderBar(trash: boolean, skip = false, canDeleteForever = true) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { drive_trash: trash } as never);
  store.set(deleteRulesAtom, {
    address: "5Me",
    skipTrash: skip,
    drives: [{ label: "default", canDeleteForever, skipsTrash: skip && canDeleteForever }],
    at: Date.now(),
  });
  const onDelete = vi.fn();
  render(
    <Provider store={store}>
      <SelectionActionBar onDelete={onDelete} />
    </Provider>,
  );
  return onDelete;
}

beforeEach(() => {
  h.selected = [FILE];
  h.clear.mockClear();
});

describe("SelectionActionBar with Trash", () => {
  it("keeps today's Delete and its confirm when the server has no Trash", () => {
    const onDelete = renderBar(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getAllByText("Delete File").length).toBeGreaterThan(0);
  });

  it("moves to Trash at once, with no confirm", () => {
    const onDelete = renderBar(true);
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(onDelete).toHaveBeenCalledWith([FILE], undefined, "trash");
    expect(screen.queryByText("Delete forever?")).toBeNull();
  });

  it("turns into Delete forever while Option is held, and asks first", () => {
    const onDelete = renderBar(true);
    act(() => {
      fireEvent.keyDown(window, { key: "Alt", altKey: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete forever?")).toBeInTheDocument();
  });

  it("always asks when Trash is skipped in Settings", () => {
    const onDelete = renderBar(true, true);
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete forever?")).toBeInTheDocument();
  });

  it("moves to Trash on Cmd+Backspace and asks on Cmd+Option+Backspace", () => {
    const onDelete = renderBar(true);
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true });
    expect(onDelete).toHaveBeenCalledWith([FILE], undefined, "trash");
    onDelete.mockClear();
    h.selected = [FILE];
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true, altKey: true });
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete forever?")).toBeInTheDocument();
  });

  it("in a drive the account may not delete forever, Option and the setting still move to Trash", () => {
    const onDelete = renderBar(true, true, false);
    act(() => {
      fireEvent.keyDown(window, { key: "Alt", altKey: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(onDelete).toHaveBeenCalledWith([FILE], undefined, "trash");
    expect(screen.queryByText("Delete forever?")).toBeNull();
  });

  it("refuses the delete-forever shortcut where the account may not, asking nothing", () => {
    const onDelete = renderBar(true, false, false);
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true, altKey: true });
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete forever?")).toBeNull();
  });
});

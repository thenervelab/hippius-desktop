import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import MoveDialog from "../MoveDialog";
import type { MoveTarget } from "../DriveMoveProvider";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notifyFilesMutated: vi.fn(),
  // Folder listings by drive-relative path.
  listings: {} as Record<string, string[]>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Account" }),
}));
vi.mock("@/app/lib/utils/fileMutationEvents", () => ({
  notifyFilesMutated: mocks.notifyFilesMutated,
}));
vi.mock("@/app/lib/hooks/use-nested-folder-listing", () => ({
  useNestedFolderListing: ({ subfolder }: { subfolder: string | null }) => ({
    data: (mocks.listings[subfolder ?? ""] ?? []).map(
      (name) => ({ name, actualFileName: name, isFolder: true }) as FormattedUserFile,
    ),
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
  }),
}));

const target: MoveTarget = {
  label: "Main",
  remote: false,
  parentPath: "",
  driveName: "My Drive",
  syncPath: "/Users/me/Hippius",
  readOnlyReason: null,
};

// Moving a file that sits in Docs, so the drive's top is a real destination.
const items = [{ path: "Docs/report.pdf", isFolder: false, name: "report.pdf" }];

function renderDialog(overrides: Partial<React.ComponentProps<typeof MoveDialog>> = {}) {
  const onClose = vi.fn();
  const onMove = vi.fn();
  render(<MoveDialog items={items} target={target} onClose={onClose} onMove={onMove} {...overrides} />);
  return { onClose, onMove };
}

const nameField = () => screen.getByRole("textbox", { name: "New folder name" });

describe("MoveDialog new folder", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.notifyFilesMutated.mockReset().mockResolvedValue(undefined);
    mocks.listings = { "": ["Docs", "Photos"], Photos: [] };
  });

  it("names the destination on the primary button", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Move to My Drive" })).toBeEnabled();
  });

  it("closes on Cancel without moving", () => {
    const { onClose, onMove } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("goes back up one folder, and offers no Back at the top of the drive", () => {
    mocks.listings = { "": ["Photos"], Photos: ["2024"], "Photos/2024": [] };
    renderDialog();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    fireEvent.click(screen.getByRole("button", { name: "2024" }));
    expect(screen.getByRole("button", { name: "Move to 2024" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Move to Photos" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Move to My Drive" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("gives New folder its own colours in both themes", () => {
    // A transparent ghost button took its colour from the card, which in
    // dark mode left New folder near-invisible.
    renderDialog();
    const newFolder = screen.getByRole("button", { name: "New folder" });
    expect(newFolder.className).toMatch(/(^|\s)text-primary-50(\s|$)/);
    expect(newFolder.className).toMatch(/dark:text-primary-brand-dark/);
  });

  it("switches the footer to Cancel and Create folder while naming", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));

    expect(nameField()).toHaveFocus();
    expect(screen.queryByRole("button", { name: /^Move to/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    // Nothing typed (or only spaces): nothing to create yet.
    const create = screen.getByRole("button", { name: "Create folder" });
    expect(create).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: "   " } });
    expect(create).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: "Invoices" } });
    expect(create).toBeEnabled();
  });

  it("Cancel leaves naming and keeps the dialog open", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(nameField(), { target: { value: "Invoices" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move to My Drive" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("Escape while naming leaves naming only; the next Escape closes", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.keyDown(nameField(), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("button", { name: "Move to My Drive" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates the folder, opens it, and offers to move there", async () => {
    let finish: (value: string) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));
    const { onMove } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(nameField(), { target: { value: "  Invoices " } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    // The trimmed name, at the drive's top (the folder the picker shows).
    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_sync_folder",
      expect.objectContaining({ accountId: "5Account", label: "Main", parentPath: null, name: "Invoices" }),
    );
    // Busy while Rust works: no second create, no Cancel.
    expect(screen.getByRole("button", { name: /Create folder/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(nameField()).toBeDisabled();

    await act(async () => finish("Invoices"));

    const moveHere = await screen.findByRole("button", { name: "Move to Invoices" });
    expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Folder" })).toHaveTextContent("My DriveInvoices");
    expect(mocks.notifyFilesMutated).toHaveBeenCalled();
    fireEvent.click(moveHere);
    expect(onMove).toHaveBeenCalledWith("Invoices", "Invoices");
  });

  it("Enter creates, the same as the button", async () => {
    mocks.invoke.mockResolvedValue("Photos/2024");
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(nameField(), { target: { value: "2024" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_sync_folder",
      expect.objectContaining({ parentPath: "Photos", name: "2024" }),
    );
    expect(await screen.findByRole("button", { name: "Move to 2024" })).toBeEnabled();
  });

  it("says a name that is already here, and will not create it", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(nameField(), { target: { value: "Docs" } });

    expect(screen.getByRole("alert")).toHaveTextContent('"Docs" already exists here.');
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Create folder" })).toBeDisabled();
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("shows Rust's refusal inline and stays in naming", async () => {
    mocks.invoke.mockRejectedValue({ kind: "Validation", message: "A folder name cannot contain a slash." });
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(nameField(), { target: { value: "a/b" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A folder name cannot contain a slash.");
    expect(nameField()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    // Editing the name clears the old answer.
    fireEvent.change(nameField(), { target: { value: "ab" } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("creates a browsed drive's folder through the remote command", async () => {
    mocks.invoke.mockResolvedValue("Invoices");
    renderDialog({ target: { ...target, remote: true, syncPath: null } });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(nameField(), { target: { value: "Invoices" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    expect(mocks.invoke).toHaveBeenCalledWith("create_remote_folder", expect.objectContaining({ name: "Invoices" }));
    expect(await screen.findByRole("button", { name: "Move to Invoices" })).toBeInTheDocument();
  });
});

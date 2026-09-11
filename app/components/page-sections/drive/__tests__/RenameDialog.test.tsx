// The dialog must be gone the moment Rename is pressed — it used to stay
// up for the whole mutation and then disappear as the toast arrived, which
// reads as the toast dismissing the dialog. A rename in a browsed remote
// drive made that seconds long (it walks the folder, moves every record
// under it and rewrites its directory rows).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import RenameDialog from "../RenameDialog";
import { renameModalFileAtom } from "@/app/lib/global-atoms/renameAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// A mutation that NEVER settles, so anything the dialog does after firing
// it is behaviour that does not depend on the rename finishing.
const renameMock = vi.fn();
vi.mock("@/app/lib/hooks/use-rename-file", () => ({
  default: () => ({ mutate: renameMock, isPending: false }),
}));

const file = (over: Partial<FormattedUserFile> = {}) =>
  ({
    name: "Trip",
    actualFileName: "Trip",
    isFolder: true,
    isAssigned: true,
    ...over,
  }) as FormattedUserFile;

function renderDialog(target = file()) {
  const store = createStore();
  store.set(renameModalFileAtom, target);
  const view = render(
    <Provider store={store}>
      <RenameDialog />
    </Provider>,
  );
  return { store, ...view };
}

const typeName = (value: string) => {
  fireEvent.change(screen.getByLabelText("New name"), { target: { value } });
};

beforeEach(() => {
  renameMock.mockReset();
});

describe("RenameDialog dismissal", () => {
  it("closes without waiting for the rename to finish", () => {
    const { store } = renderDialog();
    typeName("Holiday");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    // The mutation is in flight and will never resolve; the dialog is
    // already closed.
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(store.get(renameModalFileAtom)).toBeNull();
  });

  it("closes on Enter too, not just the button", () => {
    const { store } = renderDialog();
    typeName("Holiday");

    fireEvent.keyDown(screen.getByLabelText("New name"), { key: "Enter" });

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(store.get(renameModalFileAtom)).toBeNull();
  });

  it("still sends the trimmed new name", () => {
    renderDialog();
    typeName("  Holiday  ");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(renameMock).toHaveBeenCalledWith(
      expect.objectContaining({ newName: "Holiday" }),
    );
  });

  // `open` only flips on the next render, so autorepeat on Enter could
  // fire two renames from one dialog — the second failing post-rename with
  // a confusing "no longer available" toast.
  it("fires once even when Enter repeats before the close renders", () => {
    const input = (renderDialog(), screen.getByLabelText("New name"));
    typeName("Holiday");

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire for an unchanged name", () => {
    const { store } = renderDialog();

    fireEvent.keyDown(screen.getByLabelText("New name"), { key: "Enter" });

    expect(renameMock).not.toHaveBeenCalled();
    expect(store.get(renameModalFileAtom)).not.toBeNull();
  });

  it("does not fire for an invalid name", () => {
    renderDialog();
    typeName("bad/name");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(renameMock).not.toHaveBeenCalled();
  });
});

/**
 * With the dialog gone the instant Rename is pressed, the toast is the only
 * thing left reporting the rename — so the hook has to open a pending one
 * and REPLACE it, rather than leaving the user with a silent screen and
 * then a success message out of nowhere.
 */
describe("the rename hook reports through one toast", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const hook = readFileSync(
    join(here, "../../../../lib/hooks/use-rename-file/index.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("opens a pending toast when the rename starts", () => {
    expect(hook).toMatch(/onMutate/);
    expect(hook).toMatch(/toast\.loading/);
  });

  // Without the id both outcomes stack beside the pending toast, leaving a
  // "Renaming…" spinner on screen forever next to the result.
  it("replaces that toast in place on both outcomes", () => {
    expect(hook).toMatch(/toast\.success\([^)]*,\s*\{\s*\n?\s*id:/);
    expect(hook).toMatch(/toast\.error\([^)]*,\s*\{\s*\n?\s*id:/);
  });
});

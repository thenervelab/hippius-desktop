import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { dropVerdict } from "@/app/lib/drive-move/dropTarget";
import MoveTr from "../MoveTr";
import MoveDropTr from "../MoveDropTr";

// The drag library and the provider are replaced so the test sees exactly
// what each row registers as a target and how it paints for a given drag.
const mocks = vi.hoisted(() => ({
  droppables: new Map<string, { path: string; name: string; rowPath?: string | null }>(),
  overId: null as string | null,
  move: null as unknown,
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: ({ id, data, disabled }: { id: string; data: never; disabled: boolean }) => {
    if (!disabled) mocks.droppables.set(id, data);
    return { setNodeRef: () => {}, isOver: mocks.overId === id };
  },
  useDraggable: () => ({
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    attributes: {},
    listeners: {},
    isDragging: false,
  }),
}));
vi.mock("../DriveMoveProvider", () => ({ useDriveMove: () => mocks.move }));

const entry = (path: string, isFolder: boolean, parent?: string): FormattedUserFile =>
  ({
    name: path.split("/").pop(),
    // A file row carries its full path; a folder row only its name, with
    // the folder it is listed in beside it.
    actualFileName: isFolder ? path.split("/").pop() : path,
    parentRelativePath: isFolder ? parent : undefined,
    isFolder,
    label: "Main",
  }) as FormattedUserFile;

function context(over: { path: string; name: string; rowPath?: string } | null) {
  const items = [{ path: "Folder 2/test.pdf", isFolder: false, name: "test.pdf" }];
  return {
    target: { label: "Main", remote: false, parentPath: "", driveName: "My Drive", syncPath: null, readOnlyReason: null },
    drag: {
      items,
      over: over ? { ...over, verdict: dropVerdict(items, over, over.rowPath ?? null) } : null,
    },
    offersMove: () => true,
    canMove: () => true,
  };
}

function table(children: React.ReactNode) {
  return render(
    <table>
      <tbody>{children}</tbody>
    </table>,
  );
}

const dataFor = (rowPath: string) =>
  [...mocks.droppables.values()].find((data) => data.rowPath === rowPath);

describe("rows as drop targets", () => {
  beforeEach(() => {
    mocks.droppables.clear();
    mocks.overId = null;
    mocks.move = context(null);
  });

  it("maps every row to a folder: folders to themselves, files to the folder they are listed in", () => {
    table(
      <>
        <MoveTr file={entry("Folder 1", true, "")} currentFolder="">
          <td>Folder 1</td>
        </MoveTr>
        <MoveTr file={entry("Folder 1/notes.txt", false)} currentFolder="Folder 1">
          <td>notes.txt</td>
        </MoveTr>
        <MoveTr file={entry("Folder 1/Sub", true, "Folder 1")} currentFolder="Folder 1">
          <td>Sub</td>
        </MoveTr>
        <MoveTr file={entry("Folder 1/Sub/Deep/inner.png", false)} currentFolder="Folder 1/Sub/Deep">
          <td>inner.png</td>
        </MoveTr>
        <MoveTr file={entry("top.txt", false)} currentFolder="">
          <td>top.txt</td>
        </MoveTr>
      </>,
    );
    expect(dataFor("Folder 1")).toMatchObject({ path: "Folder 1", name: "Folder 1" });
    expect(dataFor("Folder 1/notes.txt")).toMatchObject({ path: "Folder 1", name: "Folder 1" });
    expect(dataFor("Folder 1/Sub")).toMatchObject({ path: "Folder 1/Sub", name: "Sub" });
    expect(dataFor("Folder 1/Sub/Deep/inner.png")).toMatchObject({ path: "Folder 1/Sub/Deep", name: "Deep" });
    // A top-level file stands for the folder on screen, named as the drive.
    expect(dataFor("top.txt")).toMatchObject({ path: "", name: "My Drive" });
    // One target per row, so two files in one folder never share an id.
    expect(mocks.droppables.size).toBe(5);
  });

  it("makes a loading or empty row under an expanded folder a target for that folder", () => {
    table(
      <>
        <MoveDropTr folderPath="Folder 1/Sub" label="Main">
          <td>Folder is empty.</td>
        </MoveDropTr>
        <MoveDropTr folderPath="Folder 1/Sub" label="Main">
          <td>loading</td>
        </MoveDropTr>
      </>,
    );
    const targets = [...mocks.droppables.values()];
    expect(targets).toHaveLength(2);
    expect(targets.every((data) => data.path === "Folder 1/Sub" && data.name === "Sub")).toBe(true);
  });

  it("lights the target folder's row and every visible row inside it, and nothing else", () => {
    // test.pdf from Folder 2 is over a plain file in Folder 1.
    mocks.move = context({ path: "Folder 1", name: "Folder 1", rowPath: "Folder 1/notes.txt" });
    table(
      <>
        <MoveTr data-testid="folder1" file={entry("Folder 1", true, "")} currentFolder="">
          <td />
        </MoveTr>
        <MoveTr data-testid="notes" file={entry("Folder 1/notes.txt", false)} currentFolder="Folder 1">
          <td />
        </MoveTr>
        <MoveTr data-testid="sub" file={entry("Folder 1/Sub", true, "Folder 1")} currentFolder="Folder 1">
          <td />
        </MoveTr>
        <MoveDropTr data-testid="sub-empty" folderPath="Folder 1/Sub">
          <td />
        </MoveDropTr>
        <MoveTr data-testid="folder2" file={entry("Folder 2", true, "")} currentFolder="">
          <td />
        </MoveTr>
        <MoveTr data-testid="test" file={entry("Folder 2/test.pdf", false)} currentFolder="Folder 2">
          <td />
        </MoveTr>
      </>,
    );
    expect(screen.getByTestId("folder1").className).toMatch(/outline-primary-50/);
    for (const id of ["notes", "sub", "sub-empty"]) {
      expect(screen.getByTestId(id).className).toMatch(/bg-primary-60\/10/);
      expect(screen.getByTestId(id).className).not.toMatch(/outline-primary-50/);
    }
    for (const id of ["folder2", "test"]) {
      expect(screen.getByTestId(id).className).not.toMatch(/primary/);
    }
  });

  it("lights nothing when the drop would leave the item where it is", () => {
    // test.pdf over its own sibling: the target is Folder 2, its own folder.
    mocks.move = context({ path: "Folder 2", name: "Folder 2", rowPath: "Folder 2/other.pdf" });
    table(
      <>
        <MoveTr data-testid="folder2" file={entry("Folder 2", true, "")} currentFolder="">
          <td />
        </MoveTr>
        <MoveTr data-testid="other" file={entry("Folder 2/other.pdf", false)} currentFolder="Folder 2">
          <td />
        </MoveTr>
      </>,
    );
    expect(screen.getByTestId("folder2").className).not.toMatch(/primary/);
    expect(screen.getByTestId("other").className).not.toMatch(/primary/);
  });
});

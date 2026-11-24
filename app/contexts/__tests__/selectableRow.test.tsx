// A whole drive's row (Starred) can never be selected: its source is the
// drive's sync root, so a bulk Delete or Move from the selection bar would act
// on the whole drive folder. Every way into the selection refuses it.
import React from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { FileSelectionProvider, useFileSelection } from "../FileSelectionContext";
import type { FormattedUserFile } from "../../lib/hooks/use-user-files";
import { isSelectableRow } from "../../lib/utils/selectableRow";

const row = (over: Partial<FormattedUserFile>): FormattedUserFile =>
  ({
    name: "x",
    actualFileName: "x",
    isAssigned: true,
    label: "Docs",
    arionHash: "",
    arionCid: "",
    minerIds: [],
    createdAt: 0,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    ...over,
  }) as FormattedUserFile;

const drive = row({ name: "Docs", actualFileName: "", isFolder: true, isDriveRoot: true, source: "/d" });
const folder = row({ name: "Work", actualFileName: "Work", isFolder: true, source: "/d/Work" });

describe("selecting a whole drive's row", () => {
  it("is refused by every way into the selection", () => {
    const { result } = renderHook(() => useFileSelection(), {
      wrapper: ({ children }) => <FileSelectionProvider>{children}</FileSelectionProvider>,
    });
    act(() => result.current.toggleFolderSelection(drive));
    act(() => result.current.toggleFileSelection(drive));
    act(() => result.current.enterSelectionModeAndSelectFile(drive));
    expect(result.current.selectedFiles).toEqual([]);
    act(() => result.current.selectAllFiles([drive, folder]));
    expect(result.current.selectedFiles.map((f) => f.name)).toEqual(["Work"]);
    act(() => result.current.addFilesToSelection([drive]));
    expect(result.current.selectedFiles.map((f) => f.name)).toEqual(["Work"]);
  });

  it("leaves every other synced row selectable", () => {
    expect(isSelectableRow(folder)).toBe(true);
    expect(isSelectableRow(drive)).toBe(false);
    expect(isSelectableRow({ ...folder, isAssigned: false })).toBe(false);
  });
});

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import NameClashDialog from "../NameClashDialog";

const fileClash = (name: string, takenByFolder = false) => ({
  item: { path: name, isFolder: false, name },
  takenByFolder,
});

describe("NameClashDialog", () => {
  it("asks one clash at a time and returns every answer", () => {
    const onDone = vi.fn();
    render(
      <NameClashDialog
        request={{ clashes: [fileClash("a.txt"), fileClash("b.txt")], destinationName: "Reports" }}
        onDone={onDone}
      />,
    );
    expect(screen.getByText(/a\.txt.*is already in Reports/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    expect(screen.getByText(/b\.txt.*is already in Reports/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onDone).toHaveBeenCalledWith(
      new Map([
        ["a.txt", "keepBoth"],
        ["b.txt", "replace"],
      ]),
    );
  });

  it("never offers Replace for a folder, or over one", () => {
    const { rerender } = render(
      <NameClashDialog
        request={{ clashes: [fileClash("a.txt", true)], destinationName: "Reports" }}
        onDone={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    rerender(
      <NameClashDialog
        request={{
          clashes: [{ item: { path: "Trip", isFolder: true, name: "Trip" }, takenByFolder: false }],
          destinationName: "Reports",
        }}
        onDone={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  });

  it("answers the rest with one choice, skipping Replace where it cannot apply", () => {
    const onDone = vi.fn();
    render(
      <NameClashDialog
        request={{
          clashes: [fileClash("a.txt"), fileClash("b.txt", true), fileClash("c.txt")],
          destinationName: "Reports",
        }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Do this for all 3/));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onDone).toHaveBeenCalledWith(
      new Map([
        ["a.txt", "replace"],
        ["b.txt", "skip"],
        ["c.txt", "replace"],
      ]),
    );
  });
});

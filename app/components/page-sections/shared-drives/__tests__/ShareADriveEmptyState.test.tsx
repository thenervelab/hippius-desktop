// "Shared by Me" with nothing in it: what a shared drive is for, the way to
// share one, and the docs, which open in the browser.

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

const openUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

import ShareADriveEmptyState, {
  SHARE_A_DRIVE_EMPTY_LINE,
  SHARE_A_DRIVE_EMPTY_TITLE,
  SHARED_DRIVES_DOCS_URL,
} from "../ShareADriveEmptyState";

describe("ShareADriveEmptyState", () => {
  it("says what a shared drive is for, under its own heading", () => {
    render(<ShareADriveEmptyState onShareDrive={vi.fn()} />);
    expect(screen.getByRole("region", { name: SHARE_A_DRIVE_EMPTY_TITLE })).toBeInTheDocument();
    expect(screen.getByTestId("teamwork-illustration")).toBeInTheDocument();
    expect(screen.getByText(SHARE_A_DRIVE_EMPTY_LINE)).toBeInTheDocument();
  });

  it("starts sharing from its button", () => {
    const onShareDrive = vi.fn();
    render(<ShareADriveEmptyState onShareDrive={onShareDrive} />);
    fireEvent.click(screen.getByRole("button", { name: /Share a drive/ }));
    expect(onShareDrive).toHaveBeenCalledTimes(1);
  });

  it("opens the docs in the browser, never in the app's own window", () => {
    render(<ShareADriveEmptyState onShareDrive={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: /How shared drives work/ }));
    expect(openUrlMock).toHaveBeenCalledWith(SHARED_DRIVES_DOCS_URL);
  });
});

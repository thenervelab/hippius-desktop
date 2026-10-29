// The Shared Drives page's empty and error cards: what a shared drive is
// for, the next step this account can take (Share a drive, Upgrade plan, or
// nothing for a tab that fills from other people), the docs, which open in
// the browser, and Try again for a list that could not load.

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
  SharedDrivesLoadError,
} from "../ShareADriveEmptyState";
import { sharedDrivesEmptyCopy, sharedDrivesErrorCopy } from "../sharedDrivesCopy";

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

  it("offers Upgrade plan, not Share a drive, on a plan without sharing", () => {
    const onShareDrive = vi.fn();
    const onUpgrade = vi.fn();
    render(<ShareADriveEmptyState canShare={false} onShareDrive={onShareDrive} onUpgrade={onUpgrade} />);
    expect(screen.getByText(sharedDrivesEmptyCopy("all", false).description)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Share a drive/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Upgrade plan/ }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onShareDrive).not.toHaveBeenCalled();
  });

  it("gives an empty Shared with you no button, only where the drives will appear", () => {
    render(<ShareADriveEmptyState scope="with-you" onShareDrive={vi.fn()} onUpgrade={vi.fn()} />);
    const copy = sharedDrivesEmptyCopy("with-you", true);
    expect(screen.getByRole("region", { name: copy.title })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("starts sharing from an empty Shared by you", () => {
    const onShareDrive = vi.fn();
    render(<ShareADriveEmptyState scope="by-you" onShareDrive={onShareDrive} />);
    expect(screen.getByRole("region", { name: sharedDrivesEmptyCopy("by-you", true).title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Share a drive/ }));
    expect(onShareDrive).toHaveBeenCalledTimes(1);
  });

  it("opens the docs in the browser, never in the app's own window", () => {
    render(<ShareADriveEmptyState onShareDrive={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: /How shared drives work/ }));
    expect(openUrlMock).toHaveBeenCalledWith(SHARED_DRIVES_DOCS_URL);
  });
});

describe("SharedDrivesLoadError", () => {
  it("says the list could not load, and tries again from its button", () => {
    const onRetry = vi.fn();
    render(<SharedDrivesLoadError offline={false} onRetry={onRetry} />);
    const copy = sharedDrivesErrorCopy("all", false);
    expect(screen.getByRole("alert")).toHaveTextContent(copy.title);
    expect(screen.getByText(copy.description)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says when the computer is offline", () => {
    render(<SharedDrivesLoadError scope="with-you" offline onRetry={vi.fn()} />);
    expect(screen.getByText(sharedDrivesErrorCopy("with-you", true).description)).toBeInTheDocument();
  });
});

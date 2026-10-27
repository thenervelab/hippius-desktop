// "Share a drive" in the page header, by plan: the picker on a plan that
// shares; on Free or Starter the plan requirement on the button and a click
// that goes to the upgrade, never a picker that refuses at the end; and a
// placeholder while the plan is unknown, so neither version flashes.

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

import ShareADriveButton from "../ShareADriveButton";
import { SHARING_PLAN_PILL, SHARING_PLAN_REQUIREMENT } from "../sharedDrivesCopy";

describe("ShareADriveButton", () => {
  it("opens the picker on a plan that shares", () => {
    const onShare = vi.fn();
    const onUpgrade = vi.fn();
    render(<ShareADriveButton gate="allowed" onShare={onShare} onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByRole("button", { name: "Share a drive" }));
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("names the plan it needs and goes to the upgrade on a plan without sharing", () => {
    const onShare = vi.fn();
    const onUpgrade = vi.fn();
    render(<ShareADriveButton gate="upgrade" onShare={onShare} onUpgrade={onUpgrade} />);
    const button = screen.getByRole("button", { name: new RegExp(SHARING_PLAN_REQUIREMENT.replace(/\./g, "\\.")) });
    expect(button).toHaveTextContent("Share a drive");
    expect(button).toHaveTextContent(SHARING_PLAN_PILL);
    fireEvent.click(button);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onShare).not.toHaveBeenCalled();
  });

  it("holds a placeholder while the plan is unknown, with nothing to click", () => {
    render(<ShareADriveButton gate="loading" onShare={vi.fn()} onUpgrade={vi.fn()} />);
    expect(screen.getByTestId("share-a-drive-placeholder")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

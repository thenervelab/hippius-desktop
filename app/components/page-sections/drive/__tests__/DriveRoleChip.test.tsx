// @vitest-environment jsdom
// The role chip is a verbatim port of the console's. Two clients colouring
// the same role differently is a worse fault than either palette being
// wrong, so these pin the contract rather than the exact hex.
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import DriveRoleChip from "../DriveRoleChip";
import { DRIVE_ROLES, driveRoleDescription } from "@/app/lib/shared-drives/roles";

describe("the drive role chip", () => {
  it.each([
    ["reader", "Viewer"],
    ["writer", "Editor"],
    ["manager", "Manager"],
  ] as const)("labels %s as %s", (role, label) => {
    render(<DriveRoleChip role={role} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // Colour carries the roles' own ordering, so a list of drives can be read
  // for access at a glance rather than word by word.
  it("gives each role its own tone", () => {
    const classes = DRIVE_ROLES.map((role) => {
      const { container } = render(<DriveRoleChip role={role} />);
      return container.firstElementChild?.className ?? "";
    });
    expect(new Set(classes).size).toBe(DRIVE_ROLES.length);
  });

  // Read-only is the absence of power; a colour would claim something it
  // does not have.
  it("leaves Viewer neutral and gives Manager the success tone", () => {
    const { container: viewer } = render(<DriveRoleChip role="reader" />);
    const { container: manager } = render(<DriveRoleChip role="manager" />);
    expect(viewer.firstElementChild?.className).toContain("grey");
    expect(manager.firstElementChild?.className).toContain("success");
  });

  // Amber is spoken for by the frozen/warning treatments, and two amber
  // pills side by side read as one state split in two.
  it("never uses the warning tone for a role", () => {
    for (const role of DRIVE_ROLES) {
      const { container } = render(<DriveRoleChip role={role} />);
      expect(container.firstElementChild?.className).not.toMatch(/warning|amber/);
    }
  });

  // Every tone is written for both themes: the drive list is read in each.
  it("styles both themes for every role", () => {
    for (const role of DRIVE_ROLES) {
      const { container } = render(<DriveRoleChip role={role} />);
      expect(container.firstElementChild?.className).toMatch(/dark:/);
    }
  });

  // The word says what the role is called; hovering answers what it lets
  // you do, rather than a legend nobody reads.
  it("explains the role on hover", () => {
    render(<DriveRoleChip role="manager" />);
    expect(screen.getByText("Manager")).toHaveAttribute(
      "title",
      driveRoleDescription("manager"),
    );
  });
});

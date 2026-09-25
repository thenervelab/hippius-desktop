import { describe, expect, it } from "vitest";

import {
  DRIVE_ROLES,
  canManageDrive,
  canWriteToDrive,
  driveRoleDemotionWarning,
  driveRoleDescription,
  driveRoleLabel,
  parseDriveRole,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";

describe("parseDriveRole", () => {
  it.each(DRIVE_ROLES)("passes through the wire role %s", (role) => {
    expect(parseDriveRole(role)).toBe(role);
  });

  // A former Manager keeps what an Editor can do. Reading them as a Viewer
  // (the unknown-role rule) would take away upload and delete they still have.
  it("reads a wire manager as an Editor, never a Viewer", () => {
    expect(parseDriveRole("manager")).toBe("writer");
  });

  // A role this build has never heard of must not be treated as more than it
  // is. Offering a control that fails is a smaller failure than implying
  // powers the user does not hold.
  it.each([
    ["an unknown future role", "admin"],
    ["the owner, which is identity and never a role", "owner"],
    ["a casing mismatch", "Manager"],
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
  ])("degrades %s to the least privileged role", (_label, value) => {
    expect(parseDriveRole(value as string | undefined | null)).toBe("reader");
  });
});

describe("labels", () => {
  it.each([
    ["reader", "Viewer"],
    ["writer", "Editor"],
  ] as const)("shows %s as %s", (role, label) => {
    expect(driveRoleLabel(role)).toBe(label);
  });

  it("describes every role, so the picker never renders a blank line", () => {
    for (const role of DRIVE_ROLES) {
      expect(driveRoleDescription(role).length).toBeGreaterThan(0);
    }
  });

  it("never mentions inviting or removing people: only the owner does that", () => {
    for (const role of DRIVE_ROLES) {
      expect(driveRoleDescription(role)).not.toMatch(/invit|remov|manag/i);
    }
  });
});

describe("canManageDrive", () => {
  it("lets the owner manage even with no membership row", () => {
    expect(canManageDrive({ isOwner: true })).toBe(true);
  });

  // Only the owner invites and removes people, a former Manager included.
  it.each(["manager", "writer", "reader", "admin", undefined])(
    "never lets a member manage (wire role %s)",
    (wire) => {
      expect(canManageDrive({ isOwner: false })).toBe(false);
      // The role is not an input at all; parsing it changes nothing.
      expect(parseDriveRole(wire)).not.toBe("manager");
    },
  );
});

describe("canWriteToDrive", () => {
  it("lets the owner write", () => {
    expect(canWriteToDrive({ isOwner: true })).toBe(true);
  });

  it.each([
    ["writer", true],
    ["reader", false],
  ] as const)("member with role %s: %s", (role, expected) => {
    expect(canWriteToDrive({ isOwner: false, role })).toBe(expected);
  });

  it("lets a former Manager write, as the Editor they now are", () => {
    expect(canWriteToDrive({ isOwner: false, role: parseDriveRole("manager") })).toBe(true);
  });

  it("refuses a member whose role is unknown", () => {
    expect(canWriteToDrive({ isOwner: false })).toBe(false);
  });
});

// Rust holds the same list (`WIRE_ROLES`) and refuses anything else.
describe("the roles this client offers", () => {
  it("is Viewer and Editor only", () => {
    expect(DRIVE_ROLES).toEqual(["reader", "writer"]);
  });

  it("types every offered role as a DriveRole", () => {
    const roles: DriveRole[] = [...DRIVE_ROLES];
    expect(roles).toHaveLength(2);
  });
});

// The server makes a demotion sticky, and that is not visible from the
// picker: it is discovered later as a link that stopped working.
describe("driveRoleDemotionWarning", () => {
  it("warns on an editor demoted to viewer", () => {
    expect(driveRoleDemotionWarning("writer", "reader")).toContain("revoked");
  });

  it("never mentions managers", () => {
    expect(driveRoleDemotionWarning("writer", "reader")).not.toMatch(/manager/i);
  });

  it("stays quiet on a promotion, which takes nothing away", () => {
    expect(driveRoleDemotionWarning("reader", "writer")).toBeNull();
  });

  it("stays quiet when the role did not change", () => {
    expect(driveRoleDemotionWarning("writer", "writer")).toBeNull();
    expect(driveRoleDemotionWarning("reader", "reader")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  DRIVE_ROLES,
  MANAGER_INVITE_MAX_SECONDS,
  MANAGER_INVITE_MAX_USES,
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

  // A role this build has never heard of must not be treated as management.
  // Offering a control that fails is a smaller failure than implying powers
  // the user does not hold.
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
  // The wire says reader/writer/manager; people read Viewer/Editor/Manager.
  it.each([
    ["reader", "Viewer"],
    ["writer", "Editor"],
    ["manager", "Manager"],
  ] as const)("shows %s as %s", (role, label) => {
    expect(driveRoleLabel(role)).toBe(label);
  });

  it("describes every role, so the picker never renders a blank line", () => {
    for (const role of DRIVE_ROLES) {
      expect(driveRoleDescription(role).length).toBeGreaterThan(0);
    }
  });
});

describe("canManageDrive", () => {
  it("lets the owner manage even with no membership row", () => {
    expect(canManageDrive({ isOwner: true })).toBe(true);
  });

  it.each([
    ["manager", true],
    ["writer", false],
    ["reader", false],
  ] as const)("member with role %s: %s", (role, expected) => {
    expect(canManageDrive({ isOwner: false, role })).toBe(expected);
  });

  it("refuses a member whose role is unknown", () => {
    expect(canManageDrive({ isOwner: false })).toBe(false);
  });
});

describe("canWriteToDrive", () => {
  it("lets the owner write", () => {
    expect(canWriteToDrive({ isOwner: true })).toBe(true);
  });

  it.each([
    ["manager", true],
    ["writer", true],
    ["reader", false],
  ] as const)("member with role %s: %s", (role, expected) => {
    expect(canWriteToDrive({ isOwner: false, role })).toBe(expected);
  });

  it("refuses a member whose role is unknown", () => {
    expect(canWriteToDrive({ isOwner: false })).toBe(false);
  });
});

describe("manager invite caps", () => {
  // The server hard-caps these and answers 400 past either, so the mint form
  // must stop offering the wider choices rather than mint a link the user
  // thought they had configured.
  it("matches the server's one-use, 24-hour cap", () => {
    expect(MANAGER_INVITE_MAX_USES).toBe(1);
    expect(MANAGER_INVITE_MAX_SECONDS).toBe(86_400);
  });
});

// Guards the port: the desktop and console must agree on the wire vocabulary
// or a member sees different powers depending on which client they opened.
describe("cross-client contract", () => {
  it("keeps the wire spelling the server defines", () => {
    expect(DRIVE_ROLES).toEqual(["reader", "writer", "manager"]);
  });

  it("types every wire role as a DriveRole", () => {
    const roles: DriveRole[] = [...DRIVE_ROLES];
    expect(roles).toHaveLength(3);
  });
});

// The server makes a demotion sticky, and neither effect is visible from the
// picker -- both are discovered later as links that stopped working.
describe("driveRoleDemotionWarning", () => {
  it("names the manager case, where every link that manager minted dies", () => {
    expect(driveRoleDemotionWarning("manager", "reader")).toContain(
      "every invite link they created",
    );
  });

  it("warns on an editor demoted to viewer", () => {
    expect(driveRoleDemotionWarning("writer", "reader")).toContain("revoked");
  });

  it("stays quiet on a promotion, which takes nothing away", () => {
    expect(driveRoleDemotionWarning("reader", "manager")).toBeNull();
    expect(driveRoleDemotionWarning("reader", "writer")).toBeNull();
  });

  it("stays quiet when the role did not change", () => {
    expect(driveRoleDemotionWarning("writer", "writer")).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  createDriveInvite,
  createFolderInvite,
  isEmailInvitesUnavailable,
  isFolderEditorInvitesUnavailable,
  isFolderEmailInvitesUnavailable,
  isFolderInvitesUnavailable,
  isSharedDrivesNotEntitled,
  isSharedDrivesUnavailable,
} from "@/lib/tauri/sharedDrives";

describe("isSharedDrivesUnavailable", () => {
  it("matches the feature-off server refusal by subkind, not message", () => {
    expect(
      isSharedDrivesUnavailable({
        kind: "NotReady",
        subkind: "SHARED_DRIVES_UNAVAILABLE",
        message: "reworded copy",
      })
    ).toBe(true);
  });

  it("does not treat other NotReady kinds as feature-off", () => {
    expect(
      isSharedDrivesUnavailable({
        kind: "NotReady",
        subkind: "INSUFFICIENT_CREDITS",
        message: "Shared drives unavailable",
      })
    ).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isSharedDrivesUnavailable(null)).toBe(false);
    expect(isSharedDrivesUnavailable({ kind: "Validation" })).toBe(false);
  });
});

describe("isSharedDrivesNotEntitled", () => {
  it("matches the mint plan gate by subkind, not message", () => {
    expect(
      isSharedDrivesNotEntitled({
        kind: "NotReady",
        subkind: "SHARED_DRIVES_NOT_ENTITLED",
        message: "reworded copy",
      })
    ).toBe(true);
  });

  it("does not treat the feature-off refusal as not-entitled", () => {
    expect(
      isSharedDrivesNotEntitled({
        kind: "NotReady",
        subkind: "SHARED_DRIVES_UNAVAILABLE",
        message: "off",
      })
    ).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isSharedDrivesNotEntitled(null)).toBe(false);
    expect(isSharedDrivesNotEntitled({ kind: "Auth", message: "nope" })).toBe(false);
  });
});

describe("isEmailInvitesUnavailable", () => {
  it("matches the no-mail-service refusal by subkind only", () => {
    expect(
      isEmailInvitesUnavailable({
        kind: "NotReady",
        subkind: "EMAIL_INVITES_UNAVAILABLE",
        message: "reworded",
      }),
    ).toBe(true);
    expect(
      isEmailInvitesUnavailable({
        kind: "NotReady",
        subkind: "SHARED_DRIVES_UNAVAILABLE",
        message: "Inviting by email is not available yet.",
      }),
    ).toBe(false);
    expect(isEmailInvitesUnavailable(null)).toBe(false);
  });
});

describe("the folder coming-soon refusals", () => {
  const err = (subkind: string) => ({ kind: "NotReady", subkind, message: "the same words" });

  it("each matches its own subkind and nothing else", () => {
    const matchers = {
      FOLDER_INVITES_UNAVAILABLE: isFolderInvitesUnavailable,
      FOLDER_EDITOR_INVITES_UNAVAILABLE: isFolderEditorInvitesUnavailable,
      FOLDER_EMAIL_INVITES_UNAVAILABLE: isFolderEmailInvitesUnavailable,
      EMAIL_INVITES_UNAVAILABLE: isEmailInvitesUnavailable,
    };
    for (const [subkind, matches] of Object.entries(matchers)) {
      for (const other of Object.keys(matchers)) {
        expect(matches(err(other)), `${subkind} vs ${other}`).toBe(subkind === other);
      }
    }
  });
});

describe("invite commands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ inviteUrl: "u" });
  });

  it("sends a folder invite to its own command, folder required", async () => {
    await createFolderInvite("team-docs", "Clients/ACME", { role: "writer", expiresInSecs: 60 });
    expect(invokeMock).toHaveBeenCalledWith("create_folder_invite", {
      label: "team-docs",
      pathPrefix: "Clients/ACME",
      expiresInSecs: 60,
      role: "writer",
      ownerSs58: null,
      folderHash: null,
    });
  });

  it("never sends a folder with a drive invite", async () => {
    await createDriveInvite("team-docs", { role: "reader" });
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("create_drive_invite");
    expect(args).not.toHaveProperty("pathPrefix");
  });
});

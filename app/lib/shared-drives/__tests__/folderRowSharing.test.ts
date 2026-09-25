import { describe, expect, it } from "vitest";

import {
  folderRowSharing,
  folderSharingKey,
} from "@/app/lib/shared-drives/folderRowSharing";

describe("folderRowSharing", () => {
  it("says nothing about a folder that is not shared on its own", () => {
    expect(folderRowSharing(undefined)).toEqual({
      isShared: false,
      label: null,
      title: null,
    });
    expect(
      folderRowSharing({ holderCount: 0, hasInvite: false }).isShared,
    ).toBe(false);
  });

  // Same words as the drive mark, one level down, and the tooltip says the
  // drive around it is not shared, which is the whole point of the mark.
  it("counts the people who hold the folder", () => {
    expect(folderRowSharing({ holderCount: 2, hasInvite: true })).toEqual({
      isShared: true,
      label: "Shared with 2",
      title: "Shared on its own with 2 people. The rest of the drive isn't.",
    });
    expect(folderRowSharing({ holderCount: 1, hasInvite: false }).title).toBe(
      "Shared on its own with 1 person. The rest of the drive isn't.",
    );
  });

  it("marks a folder with only an invite out, live or spent, as Shared", () => {
    expect(folderRowSharing({ holderCount: 0, hasInvite: true })).toEqual({
      isShared: true,
      label: "Shared",
      title: "Shared on its own. The rest of the drive isn't.",
    });
  });
});

describe("folderSharingKey", () => {
  it("keys a path the way Rust does: no surrounding slashes, NFC", () => {
    expect(folderSharingKey("/Clients/ACME/")).toBe("Clients/ACME");
    expect(folderSharingKey("Café")).toBe("Café");
    expect(folderSharingKey(null)).toBe("");
    expect(folderSharingKey("/")).toBe("");
  });
});

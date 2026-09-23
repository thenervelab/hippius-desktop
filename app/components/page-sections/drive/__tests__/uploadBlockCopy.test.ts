import { describe, expect, it } from "vitest";

import { NO_PLAN_RETENTION_DAYS } from "../service-status/driveStatusBannerState";
import {
  blockedUploadInteraction,
  getUploadBlockDialogCopy,
} from "../uploadBlockCopy";

describe("getUploadBlockDialogCopy", () => {
  it("matches the no-plan banner: 30-day deletion, Subscribe", () => {
    const copy = getUploadBlockDialogCopy("no-plan");
    expect(copy.title).toBe("You don't have a subscription plan");
    expect(copy.description).toContain(`${NO_PLAN_RETENTION_DAYS} days`);
    expect(copy.description).toContain("permanently deleted");
    expect(copy.description).toContain("nothing new can be uploaded");
    expect(copy.primaryLabel).toBe("Subscribe");
    expect(copy.description).not.toMatch(/—/);
    expect(copy.description).not.toMatch(/\bstay available\b/);
  });

  it("matches the free over-quota banner: files stay, Upgrade", () => {
    const copy = getUploadBlockDialogCopy("over-capacity", "free");
    expect(copy.title).toBe("You're over your free storage");
    expect(copy.description).toBe(
      "Uploads are paused, your files stay available. Upgrade or free up space.",
    );
    expect(copy.primaryLabel).toBe("Upgrade");
    expect(copy.description).not.toContain("days");
    expect(copy.description).not.toMatch(/—/);
  });

  it("matches the paid over-quota banner: files stay, Upgrade", () => {
    const copy = getUploadBlockDialogCopy("over-capacity", "subscription");
    expect(copy.title).toBe("You're over your plan's storage");
    expect(copy.description).toContain("files stay available");
    expect(copy.description).not.toContain("days");
    expect(copy.primaryLabel).toBe("Upgrade");
    expect(copy.description).not.toMatch(/—/);
  });
});

describe("blockedUploadInteraction", () => {
  it("disables toolbar buttons and context-menu items", () => {
    expect(blockedUploadInteraction("button")).toBe("disable");
    expect(blockedUploadInteraction("context-menu")).toBe("disable");
  });

  it("opens the dialog on drag-and-drop instead of uploading", () => {
    expect(blockedUploadInteraction("drag-drop")).toBe("show-dialog");
  });
});

import { describe, it, expect } from "vitest";
import { ticketCategories, ticketCategoryLabel } from "../ticketCategories";

describe("ticketCategories", () => {
  it("offers no product the desktop does not have", () => {
    // Offering S3, which the desktop does not do, is why the list was redone.
    const values = ticketCategories.map((c) => c.value);
    expect(values).not.toContain("s3");
    expect(values).not.toContain("hub");
  });

  it("files each topic under the value the console uses for it", () => {
    // Staff filter the queue by these values, and the console files the same
    // topics under the same ones. Renaming one splits the queue in two.
    expect(ticketCategories.map((c) => c.value)).toEqual([
      "drive",
      "shared_drives",
      "credits",
      "subscription",
      "account",
      "feedback",
      "other",
    ]);
  });
});

describe("ticketCategoryLabel", () => {
  it("labels a ticket filed from the console under S3 or Hub", () => {
    expect(ticketCategoryLabel("s3")).toBe("S3");
    expect(ticketCategoryLabel("hub")).toBe("Hub");
  });

  it("still labels tickets filed under the old categories", () => {
    expect(ticketCategoryLabel("billing")).toBe("Account & billing");
    expect(ticketCategoryLabel("storage")).toBe("Storage");
    expect(ticketCategoryLabel("general")).toBe("General");
  });

  it("shows a category it does not know as the stored value", () => {
    expect(ticketCategoryLabel("something_new")).toBe("something_new");
  });
});

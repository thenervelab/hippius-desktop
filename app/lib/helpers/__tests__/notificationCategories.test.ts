import { describe, it, expect } from "vitest";
import { notificationCategoryLabel } from "../notificationCategories";

describe("notificationCategoryLabel", () => {
  it("surfaces the 'Files' category as 'Drive'", () => {
    expect(notificationCategoryLabel("Files")).toBe("Drive");
  });

  it("returns the category key unchanged when it has no display override", () => {
    // Credits keeps its name; the filter key must stay identical to the data key.
    expect(notificationCategoryLabel("Credits")).toBe("Credits");
    expect(notificationCategoryLabel("Hippius")).toBe("Hippius");
  });
});

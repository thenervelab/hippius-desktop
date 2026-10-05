import { describe, it, expect } from "vitest";
import { resolveRowRelativePath } from "@/app/lib/utils/rowRelativePath";

describe("resolveRowRelativePath", () => {
  it("joins a basename onto the folder being shown", () => {
    expect(resolveRowRelativePath("Work", "notes.txt")).toBe("Work/notes.txt");
    expect(resolveRowRelativePath("", "notes.txt")).toBe("notes.txt");
  });

  it("keeps a name that already carries its path", () => {
    expect(resolveRowRelativePath("Work", "Work/notes.txt")).toBe("Work/notes.txt");
    expect(resolveRowRelativePath("Work", "Trips/notes.txt")).toBe("Trips/notes.txt");
    expect(resolveRowRelativePath("", "/Trips/notes.txt/")).toBe("Trips/notes.txt");
  });

  // The URL's subFolderPath can carry leading or trailing slashes; the
  // table's own resolver call trims it, so this one must too.
  it("trims slashes off the folder path", () => {
    expect(resolveRowRelativePath("/Work/", "notes.txt")).toBe("Work/notes.txt");
    expect(resolveRowRelativePath("/Work", "Work/notes.txt")).toBe("Work/notes.txt");
    expect(resolveRowRelativePath("/", "notes.txt")).toBe("notes.txt");
  });
});

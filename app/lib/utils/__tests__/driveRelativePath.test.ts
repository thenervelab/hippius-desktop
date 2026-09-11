import { describe, it, expect } from "vitest";
import { driveRelativePathFor } from "../driveRelativePath";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const row = (over: Partial<FormattedUserFile>): FormattedUserFile =>
  ({ name: "Trips", ...over }) as FormattedUserFile;

describe("driveRelativePathFor", () => {
  // The bug this fixes: a nested folder row shows a basename and keeps
  // its path beside it, so sending the name addressed a folder of the
  // same name at the drive root — or, far more often, nothing at all.
  it("rebuilds a nested folder's path from its parent", () => {
    expect(
      driveRelativePathFor(
        row({ isFolder: true, name: "2024", parentRelativePath: "Photos" }),
      ),
    ).toBe("Photos/2024");
  });

  it("falls back to the surface's own path when the row carries none", () => {
    expect(
      driveRelativePathFor(row({ isFolder: true, name: "2024" }), "Photos"),
    ).toBe("Photos/2024");
  });

  it("leaves a folder at the drive root alone", () => {
    expect(driveRelativePathFor(row({ isFolder: true, name: "Photos" }))).toBe(
      "Photos",
    );
  });

  // A file's actualFileName already carries its full path.
  it("uses a file's own qualified name", () => {
    expect(
      driveRelativePathFor(
        row({ isFolder: false, name: "a.jpg", actualFileName: "Photos/a.jpg" }),
      ),
    ).toBe("Photos/a.jpg");
  });

  // Same-named nesting is ordinary — `src/src`, an archive that re-nests
  // its own directory — so collapsing them would address the PARENT, a
  // strict superset of what the user picked.
  it("does not collapse a folder nested inside its own name", () => {
    expect(
      driveRelativePathFor(
        row({ isFolder: true, name: "Trips", parentRelativePath: "Trips" }),
      ),
    ).toBe("Trips/Trips");
  });

  it("tolerates stray separators around either half", () => {
    expect(
      driveRelativePathFor(
        row({ isFolder: true, name: "/2024/", parentRelativePath: "/Photos/" }),
      ),
    ).toBe("Photos/2024");
  });

  // An already-qualified name must not be prefixed a second time.
  it("leaves an already-qualified folder name alone", () => {
    expect(
      driveRelativePathFor(
        row({
          isFolder: true,
          name: "2024",
          actualFileName: "Photos/2024",
          parentRelativePath: "Photos",
        }),
      ),
    ).toBe("Photos/2024");
  });
});

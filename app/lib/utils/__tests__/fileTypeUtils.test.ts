// Pins the display-name truncation ladder and the icon mappings the file
// rows, card view, and viewer filmstrip all render from.

import { describe, it, expect } from "vitest";

import {
  DIRECTORY_SUFFIX,
  isDirectory,
  formatDisplayName,
  getFileIcon,
  getFileIconForThumbnail,
} from "@/app/lib/utils/fileTypeUtils";
import {
  Document,
  DocumentText,
  EC,
  File,
  Folder2,
  Image,
  ImageWhite,
  Note,
  PDF,
  Presentation,
  Sheet,
  SVG,
  Terminal,
  TerminalWhite,
  Video,
  Zip,
} from "@/components/ui/icons";
import type { FileTypes } from "@/lib/types/fileTypes";

describe("isDirectory", () => {
  it("recognises the ec-metadata suffix and nothing else", () => {
    expect(isDirectory(`photos${DIRECTORY_SUFFIX}`)).toBe(true);
    expect(isDirectory("photos")).toBe(false);
    expect(isDirectory("archive.zip")).toBe(false);
  });
});

describe("formatDisplayName", () => {
  it("strips the directory suffix", () => {
    expect(formatDisplayName(`photos${DIRECTORY_SUFFIX}`)).toBe("photos");
  });

  it("leaves short names untouched", () => {
    expect(formatDisplayName("IMG_0042.jpg")).toBe("IMG_0042.jpg");
  });

  it("truncates a long base name but keeps the extension", () => {
    const name = "a-very-long-holiday-photo-export.jpeg";
    const formatted = formatDisplayName(name);
    expect(formatted).toBe("a-very-lon...-export.jpeg");
  });

  it("keeps a long name whose base fits once the extension is split off", () => {
    // 21 chars total, 16-char base: over the limit only with the extension.
    expect(formatDisplayName("summer-vacation1.jpeg")).toBe("summer-vacation1.jpeg");
  });

  it("truncates the whole name when there is no usable extension", () => {
    // A trailing dot is not an extension; the plain head...tail cut applies.
    expect(formatDisplayName("a-very-long-name-without-extension.")).toBe(
      "a-very-lon...ension.",
    );
  });

  it("treats a leading dot as a dotfile, not an extension", () => {
    expect(formatDisplayName(".a-very-long-hidden-configuration")).toBe(
      ".a-very-lo...uration",
    );
  });
});

describe("getFileIcon", () => {
  it("folder wins over any file type", () => {
    expect(getFileIcon("image", true).icon).toBe(Folder2);
  });

  it("maps every known type to its icon", () => {
    const expected: Array<[FileTypes, React.FC<Record<string, unknown>>]> = [
      ["video", Video],
      ["audio", Note],
      ["ec", EC],
      ["document", File],
      ["PDF", PDF],
      ["PPT", Presentation],
      ["XLS", Sheet],
      ["code", Terminal],
      ["svg", SVG],
      ["doc", Document],
      ["image", Image],
      ["archive", Zip],
      ["disk_image", File],
      ["markdown", DocumentText],
      ["sql", Terminal],
    ];
    for (const [type, icon] of expected) {
      expect(getFileIcon(type, false).icon, type).toBe(icon);
    }
  });

  it("keeps the svg icon legible in both themes", () => {
    // `fill="currentColor"` icon: a bare text-black is invisible on dark
    // surfaces, so the color must carry a dark-mode variant.
    expect(getFileIcon("svg", false).color).toContain("dark:");
  });

  it("falls back to the generic file icon for unknown types", () => {
    expect(getFileIcon(undefined, false).icon).toBe(File);
    expect(getFileIcon("audio", false).icon).not.toBe(File);
  });
});

describe("getFileIconForThumbnail", () => {
  it("folder wins and paints white for the dark thumbnail chrome", () => {
    const folder = getFileIconForThumbnail("image", true);
    expect(folder.icon).toBe(Folder2);
    expect(folder.color).toBe("fill-white");
  });

  it("maps every known type, using the white variants where the row icon differs", () => {
    const expected: Array<[FileTypes, React.FC<Record<string, unknown>>]> = [
      ["video", Video],
      ["audio", Note],
      ["ec", EC],
      ["document", File],
      ["PDF", PDF],
      ["PPT", Presentation],
      ["XLS", Sheet],
      ["code", TerminalWhite],
      ["svg", SVG],
      ["doc", Document],
      ["image", ImageWhite],
      ["archive", Zip],
      ["disk_image", File],
      ["markdown", DocumentText],
      ["sql", TerminalWhite],
    ];
    for (const [type, icon] of expected) {
      expect(getFileIconForThumbnail(type, false).icon, type).toBe(icon);
    }
  });

  it("falls back to the generic file icon for unknown types", () => {
    expect(getFileIconForThumbnail(undefined, false).icon).toBe(File);
  });
});

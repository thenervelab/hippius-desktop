// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  getFileTypeFromExtension,
  getFileTypeDisplayLabel,
} from "../getTileTypeFromExtension";

describe("getFileTypeFromExtension", () => {
  it("returns 'archive' for .zip", () => {
    expect(getFileTypeFromExtension("zip")).toBe("archive");
  });

  it("returns 'disk_image' for .dmg", () => {
    expect(getFileTypeFromExtension("dmg")).toBe("disk_image");
  });

  it("returns 'disk_image' for disk image formats", () => {
    expect(getFileTypeFromExtension("iso")).toBe("disk_image");
    expect(getFileTypeFromExtension("img")).toBe("disk_image");
  });

  it("returns 'archive' for actual archive formats", () => {
    expect(getFileTypeFromExtension("tar")).toBe("archive");
    expect(getFileTypeFromExtension("gz")).toBe("archive");
    expect(getFileTypeFromExtension("rar")).toBe("archive");
    expect(getFileTypeFromExtension("7z")).toBe("archive");
  });

  it("returns null for executables (not archives)", () => {
    expect(getFileTypeFromExtension("exe")).toBeNull();
    expect(getFileTypeFromExtension("msi")).toBeNull();
    expect(getFileTypeFromExtension("app")).toBeNull();
  });

  it("returns 'image' for common image extensions", () => {
    expect(getFileTypeFromExtension("png")).toBe("image");
    expect(getFileTypeFromExtension("jpg")).toBe("image");
    expect(getFileTypeFromExtension("jpeg")).toBe("image");
    expect(getFileTypeFromExtension("gif")).toBe("image");
    expect(getFileTypeFromExtension("webp")).toBe("image");
    expect(getFileTypeFromExtension("bmp")).toBe("image");
    expect(getFileTypeFromExtension("heic")).toBe("image");
  });

  it("returns 'video' for video extensions", () => {
    expect(getFileTypeFromExtension("mp4")).toBe("video");
    expect(getFileTypeFromExtension("mov")).toBe("video");
    expect(getFileTypeFromExtension("mkv")).toBe("video");
    expect(getFileTypeFromExtension("webm")).toBe("video");
  });

  it("returns 'audio' for audio extensions", () => {
    expect(getFileTypeFromExtension("mp3")).toBe("audio");
    expect(getFileTypeFromExtension("wav")).toBe("audio");
    expect(getFileTypeFromExtension("flac")).toBe("audio");
    expect(getFileTypeFromExtension("aac")).toBe("audio");
    expect(getFileTypeFromExtension("m4a")).toBe("audio");
    // "ogg" is in SUPPORTED_VIDEO_FORMATS, so it maps to "video" (checked first)
  });

  it("returns 'PDF' for pdf", () => {
    expect(getFileTypeFromExtension("pdf")).toBe("PDF");
  });

  it("returns 'doc' for word documents", () => {
    expect(getFileTypeFromExtension("doc")).toBe("doc");
    expect(getFileTypeFromExtension("docx")).toBe("doc");
  });

  it("returns 'PPT' for presentations", () => {
    expect(getFileTypeFromExtension("ppt")).toBe("PPT");
    expect(getFileTypeFromExtension("pptx")).toBe("PPT");
  });

  it("returns 'XLS' for spreadsheets", () => {
    expect(getFileTypeFromExtension("xls")).toBe("XLS");
    expect(getFileTypeFromExtension("xlsx")).toBe("XLS");
  });

  it("returns 'code' for code files", () => {
    expect(getFileTypeFromExtension("json")).toBe("code");
    expect(getFileTypeFromExtension("js")).toBe("code");
    expect(getFileTypeFromExtension("ts")).toBe("code");
    expect(getFileTypeFromExtension("py")).toBe("code");
    expect(getFileTypeFromExtension("rs")).toBe("code");
    expect(getFileTypeFromExtension("html")).toBe("code");
    expect(getFileTypeFromExtension("css")).toBe("code");
  });

  it("returns 'markdown' for markdown files", () => {
    expect(getFileTypeFromExtension("md")).toBe("markdown");
    expect(getFileTypeFromExtension("mdx")).toBe("markdown");
  });

  it("returns 'sql' for database files", () => {
    expect(getFileTypeFromExtension("sql")).toBe("sql");
    expect(getFileTypeFromExtension("sqlite")).toBe("sql");
  });

  it("returns 'svg' for svg", () => {
    expect(getFileTypeFromExtension("svg")).toBe("svg");
  });

  it("returns 'document' for text files", () => {
    expect(getFileTypeFromExtension("txt")).toBe("document");
    expect(getFileTypeFromExtension("csv")).toBe("document");
  });

  it("returns null for unknown extensions", () => {
    expect(getFileTypeFromExtension("xyz")).toBeNull();
    expect(getFileTypeFromExtension("foobar")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(getFileTypeFromExtension(null)).toBeNull();
    expect(getFileTypeFromExtension("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(getFileTypeFromExtension("ZIP")).toBe("archive");
    expect(getFileTypeFromExtension("DMG")).toBe("disk_image");
    expect(getFileTypeFromExtension("PNG")).toBe("image");
    expect(getFileTypeFromExtension("PDF")).toBe("PDF");
    expect(getFileTypeFromExtension("Mp4")).toBe("video");
  });
});

describe("getFileTypeDisplayLabel", () => {
  it("returns 'Archive' for archive type", () => {
    expect(getFileTypeDisplayLabel("archive")).toBe("Archive");
  });

  it("returns 'Image' for image type", () => {
    expect(getFileTypeDisplayLabel("image")).toBe("Image");
  });

  it("returns 'Video' for video type", () => {
    expect(getFileTypeDisplayLabel("video")).toBe("Video");
  });

  it("returns 'Audio' for audio type", () => {
    expect(getFileTypeDisplayLabel("audio")).toBe("Audio");
  });

  it("returns 'PDF' for PDF type", () => {
    expect(getFileTypeDisplayLabel("PDF")).toBe("PDF");
  });

  it("returns 'Document' for doc type", () => {
    expect(getFileTypeDisplayLabel("doc")).toBe("Document");
  });

  it("returns 'Presentation' for PPT type", () => {
    expect(getFileTypeDisplayLabel("PPT")).toBe("Presentation");
  });

  it("returns 'Spreadsheet' for XLS type", () => {
    expect(getFileTypeDisplayLabel("XLS")).toBe("Spreadsheet");
  });

  it("returns 'Code' for code type", () => {
    expect(getFileTypeDisplayLabel("code")).toBe("Code");
  });

  it("returns 'Markdown' for markdown type", () => {
    expect(getFileTypeDisplayLabel("markdown")).toBe("Markdown");
  });

  it("returns 'Disk Image' for disk_image type", () => {
    expect(getFileTypeDisplayLabel("disk_image")).toBe("Disk Image");
  });

  it("returns 'Unknown' for null/undefined", () => {
    expect(getFileTypeDisplayLabel(null)).toBe("Unknown");
    expect(getFileTypeDisplayLabel(undefined)).toBe("Unknown");
  });

  it("returns 'Folder' when isFolder is true", () => {
    expect(getFileTypeDisplayLabel(null, true)).toBe("Folder");
    expect(getFileTypeDisplayLabel("image", true)).toBe("Folder");
  });
});

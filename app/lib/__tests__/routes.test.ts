import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { BILLING_ROUTE, driveFolderRoute, sharedDriveRoute } from "../routes";

describe("driveFolderRoute", () => {
  // A capture's "Show in folder" opens the drive, then its Captures folder.
  it("can open one level into the drive", () => {
    const url = new URL(driveFolderRoute("Work", true, "Captures"), "http://x");
    expect(url.searchParams.get("openLabel")).toBe("Work");
    expect(url.searchParams.get("openRemote")).toBe("1");
    expect(url.searchParams.get("openSubfolder")).toBe("Captures");
    expect(driveFolderRoute("Work", false)).not.toContain("openSubfolder");
  });

  // "Show in folder" points the file out once the folder is open.
  it("carries the file to point out, encoded", () => {
    const url = new URL(driveFolderRoute("Work", false, "Captures", "Screen Recording 2026 #1.mp4"), "http://x");
    expect(url.searchParams.get("openSubfolder")).toBe("Captures");
    expect(url.searchParams.get("openFile")).toBe("Screen Recording 2026 #1.mp4");
    expect(driveFolderRoute("Work", false, "Captures")).not.toContain("openFile");
  });

  it("names the folder to open", () => {
    expect(driveFolderRoute("chains", false)).toBe("/files?openLabel=chains");
  });

  // Local and server-only folders open through different paths on the
  // Drive page, and guessing from the label is the H-077 mistake.
  it("marks a server-only folder as remote", () => {
    expect(driveFolderRoute("Camera Uploads", true)).toContain("openRemote=1");
    expect(driveFolderRoute("chains", false)).not.toContain("openRemote");
  });

  // Labels come from folder names, which contain spaces, & and #.
  it("encodes a label that would otherwise break the query", () => {
    const route = driveFolderRoute("Photos & Video #1", false);
    expect(route).not.toContain(" ");
    const value = new URLSearchParams(route.split("?")[1]).get("openLabel");
    expect(value).toBe("Photos & Video #1");
  });

  it("round-trips a suffixed label unchanged", () => {
    // Two folders sharing a basename get `tags` and `tags-2`; opening by
    // display name would land on the wrong drive.
    const route = driveFolderRoute("tags-2", false);
    expect(new URLSearchParams(route.split("?")[1]).get("openLabel")).toBe("tags-2");
  });
});

/**
 * Plans & Billing is a page under the main sidebar, as in the console.
 * Every money prompt in the app goes through `BILLING_ROUTE`, so this is
 * where "it opened Settings instead" would come back.
 */
describe("BILLING_ROUTE", () => {
  it("points at the Plans & Billing page", () => {
    expect(BILLING_ROUTE).toBe("/billing");
  });

  // The main sidebar hides itself under /settings and draws the Settings
  // sidebar instead, so any /settings address is "opens Settings".
  it("is not a Settings address", () => {
    expect(BILLING_ROUTE.startsWith("/settings")).toBe(false);
  });

  // The sidebar lights an entry by comparing its path with
  // `usePathname()`, which never carries a query or a hash.
  it("is a bare path, so the sidebar can mark Plans & Billing as open", () => {
    const url = new URL(BILLING_ROUTE, "https://app.invalid");
    expect(url.pathname).toBe(BILLING_ROUTE);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  // Rust writes the low-credits notification's link itself; the two must
  // name the same page or "View Billing" opens Settings again.
  it("is where Rust's low-credits notification links", () => {
    const rust = readFileSync(
      resolve(process.cwd(), "src-tauri/src/notifications/credits.rs"),
      "utf8",
    );
    expect(rust).toContain(`pub const BILLING_LINK: &str = "${BILLING_ROUTE}";`);
  });
});

describe("sharedDriveRoute", () => {
  it("opens a shared drive as a remote drive, carrying the name to show", () => {
    const url = new URL(`app://x${sharedDriveRoute("shared:5Abc~0123456789abcdef", "Team & co")}`);
    expect(url.pathname).toBe("/files");
    expect(url.searchParams.get("openLabel")).toBe("shared:5Abc~0123456789abcdef");
    expect(url.searchParams.get("openRemote")).toBe("1");
    expect(url.searchParams.get("openName")).toBe("Team & co");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "../page.tsx"), "utf8");
const meta = page.slice(
  page.indexOf("const SECTION_META"),
  page.indexOf("function SettingsContent"),
);

/**
 * Every capture setting lives in its own section now, not at the bottom of
 * Sync & Storage, behind the same capture flag as its sidebar entry.
 */
describe("the Screenshots & Recording section", () => {
  it("has a heading and a guide of its own, with no em dashes", () => {
    const capture = meta.slice(meta.indexOf("[CAPTURE_SETTINGS_SECTION]: {"), meta.indexOf("appearance: {"));
    expect(capture).toContain('title: "Screenshots & Recording"');
    expect(capture).toContain("tooltip:");
    expect(capture).not.toContain("—");
  });

  it("renders the capture settings there, behind capture availability, and not under Sync & Storage", () => {
    expect(page).toContain("{captureSection && section === CAPTURE_SETTINGS_SECTION && <CaptureSettings />}");
    const syncStart = page.indexOf('{section === "sync" && (');
    const sync = page.slice(syncStart, page.indexOf("</>", syncStart));
    expect(sync).not.toContain("<CaptureSettings");
    expect(page.match(/<CaptureSettings \/>/g)).toHaveLength(1);
  });

  // Production carries the flag on every platform, so the flag alone would
  // keep the section reachable on a computer that cannot capture.
  it("is reachable by its query string unless capture is unavailable on this computer", () => {
    expect(page).toMatch(/const captureSection = useCaptureAvailability\(\) !== "unavailable";/);
    expect(page).toMatch(/captureEnabled: captureSection,/);
    expect(page).not.toContain("SCREEN_CAPTURE_ENABLED");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function flagOn(channel: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (channel === undefined) vi.stubEnv("RELEASE_CHANNEL", "");
  else vi.stubEnv("RELEASE_CHANNEL", channel);
  const { DRIVE_MOVE_ENABLED } = await import("../featureFlags");
  return DRIVE_MOVE_ENABLED;
}

/**
 * Move to... and drag-and-drop moves ship in every build. The flag stays so
 * Move can be taken away in one line, so this pins both halves: it is on in
 * each lane, and turning it off is still what hides every entry point.
 */
describe("Move within a drive", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is on in staging, beta and production builds, and with no channel set", async () => {
    expect(await flagOn("staging")).toBe(true);
    expect(await flagOn("beta")).toBe(true);
    expect(await flagOn("production")).toBe(true);
    expect(await flagOn(undefined)).toBe(true);
  });

  it("can still be taken away in one place: the drive's move target", () => {
    // Menus, the selection bar, drag rows and the hint all render nothing
    // without a move target, so this one gate is what hides Move.
    const container = readFileSync(
      join(here, "../../components/page-sections/drive/DriveContainer.tsx"),
      "utf8",
    );
    expect(container).toMatch(
      /const moveTarget = useMemo<MoveTarget \| null>\(\(\) => \{\s*if \(!DRIVE_MOVE_ENABLED \|\|/,
    );
  });
});

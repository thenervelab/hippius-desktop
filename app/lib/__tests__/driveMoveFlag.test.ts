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
 * Move to... and drag-and-drop moves are held back to internal builds while
 * the drag targets are reworked. A beta or production build must not offer
 * them at all.
 */
describe("Move within a drive is internal only", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is on in a staging build", async () => {
    expect(await flagOn("staging")).toBe(true);
  });

  it("is off in beta and production builds, and when the channel is unset", async () => {
    expect(await flagOn("beta")).toBe(false);
    expect(await flagOn("production")).toBe(false);
    expect(await flagOn(undefined)).toBe(false);
  });

  it("removes every entry point by giving the drive no move target", () => {
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

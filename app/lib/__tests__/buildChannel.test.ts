import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  enabledFrom,
  isEnabledOn,
  parseBuildChannel,
  type BuildChannel,
} from "@/app/lib/buildChannel";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

const CHANNELS: BuildChannel[] = ["production", "beta", "staging"];

/**
 * The parser is a second implementation of Rust's `parse_release_channel`
 * — there is no codegen across the IPC boundary — so it has to agree with
 * it on every input, especially the fail-safe.
 */
describe("parseBuildChannel", () => {
  it("recognises each lane", () => {
    expect(parseBuildChannel("production")).toBe("production");
    expect(parseBuildChannel("beta")).toBe("beta");
    expect(parseBuildChannel("staging")).toBe("staging");
  });

  // The value comes from a workflow env line, where both are easy to
  // introduce and neither is meaningful.
  it("tolerates casing and whitespace", () => {
    expect(parseBuildChannel("  Staging ")).toBe("staging");
    expect(parseBuildChannel("BETA")).toBe("beta");
  });

  // The only direction that cannot hand a real user a prerelease lane's
  // behaviour. A typo produces a production build, never a beta one.
  it("fails safe to production on anything unrecognised", () => {
    for (const raw of [undefined, null, "", "   ", "stagging", "betta", "prod"]) {
      expect(parseBuildChannel(raw)).toBe("production");
    }
  });
});

/**
 * Staging is upstream of beta, which is upstream of production, so a
 * feature visible in beta must also be visible in staging — that is where
 * it was tested first. Getting this backwards hides a feature from the
 * lane meant to prove it.
 */
describe("channel ordering", () => {
  it("shows a beta feature in beta and staging, never in production", () => {
    expect(isEnabledOn("beta", "beta")).toBe(true);
    expect(isEnabledOn("beta", "staging")).toBe(true);
    expect(isEnabledOn("beta", "production")).toBe(false);
  });

  it("keeps a staging feature internal", () => {
    expect(isEnabledOn("staging", "staging")).toBe(true);
    expect(isEnabledOn("staging", "beta")).toBe(false);
    expect(isEnabledOn("staging", "production")).toBe(false);
  });

  it("shows a production feature everywhere", () => {
    for (const channel of CHANNELS) {
      expect(isEnabledOn("production", channel)).toBe(true);
    }
  });

  it("always shows a lane its own features", () => {
    for (const channel of CHANNELS) {
      expect(isEnabledOn(channel, channel)).toBe(true);
    }
  });
});

/**
 * Tests and `pnpm dev` set no channel, so every gate reads as production —
 * a developer sees what a user sees. This is also what keeps the existing
 * flag assertions meaningful.
 */
describe("the local build", () => {
  it("is production, so a gated feature is off by default", () => {
    expect(enabledFrom("beta")).toBe(false);
    expect(enabledFrom("staging")).toBe(false);
    expect(enabledFrom("production")).toBe(true);
  });
});

/**
 * Two silent failures live in the wiring, not the logic. Neither breaks a
 * build, and both look exactly like "the feature is off".
 */
describe("the channel actually reaches the bundle", () => {
  // Without this line `process.env.RELEASE_CHANNEL` is undefined in every
  // build, so a beta-only feature never appears in beta and nothing says
  // why.
  it("next.config.ts forwards the variable Rust reads", () => {
    const config = read("next.config.ts");
    expect(config).toMatch(/RELEASE_CHANNEL:\s*process\.env\.HIPPIUS_RELEASE_CHANNEL/);
  });

  // Reading a DIFFERENT variable than the workflows export is the same
  // failure with a longer search.
  it("reads the same variable name the workflows export", () => {
    for (const lane of ["tauri-beta.yml", "tauri-staging.yml"]) {
      expect(read(`.github/workflows/${lane}`)).toContain("HIPPIUS_RELEASE_CHANNEL:");
    }
  });
});

/**
 * The point of the whole mechanism: the lane decides, so this file is
 * identical on staging, beta and main. A literal here would have to be
 * edited per branch, which is the merge hazard that shipped a broken
 * production updater key.
 */
describe("shared drives is gated by lane, not by branch", () => {
  const flags = read("app/lib/featureFlags.ts");

  it("turns on from beta outwards", () => {
    expect(flags).toMatch(/SHARED_DRIVES_ENABLED\s*=\s*enabledFrom\("beta"\)/);
  });

  it("is not a per-branch literal", () => {
    expect(flags).not.toMatch(/SHARED_DRIVES_ENABLED\s*=\s*(true|false)/);
  });
});

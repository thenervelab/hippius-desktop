/**
 * The release lane this BUILD was compiled for, and the gate that turns a
 * lane into a feature flag.
 *
 * The channel is decided once, at compile time, by the same
 * `HIPPIUS_RELEASE_CHANNEL` environment variable Rust's
 * `release_channel.rs` reads: `tauri-beta.yml` exports `beta`,
 * `tauri-staging.yml` exports `staging`, and the production workflow
 * leaves it unset. `next.config.ts` forwards it into the bundle, and the
 * frontend build runs inside `tauri build` (`beforeBuildCommand`), so both
 * sides read ONE variable and cannot disagree about which lane a build is.
 *
 * Compile time, not the `current_release_channel` IPC, for two reasons.
 * These gates are read at module scope — the sidebar filter, the route
 * redirects — so an async answer would change their shape and flash the
 * wrong UI while it resolved. And a build-time constant lets dead branches
 * be reasoned about like any other `false`.
 *
 * **This is the alternative to a per-branch flag value, and that is the
 * whole point.** Setting a flag `true` on `beta` and `false` on `main`
 * puts a difference in a file that gets merged, and `staging → beta` is a
 * merge while `beta → main` is a squash: the value either conflicts on
 * every promotion until someone resolves it the wrong way, or rides into
 * production through a hunk nobody looked at. That is the same shape as
 * the per-branch updater pubkey, which shipped a production release whose
 * update signature failed against every installed copy with no error
 * anywhere. One file, identical on all three branches; the LANE decides.
 */

/** Mirrors Rust's `ReleaseChannel`, in the same lowercase wire spelling. */
export type BuildChannel = "production" | "beta" | "staging";

/**
 * How far a lane is from production, so a gate can say "beta and above".
 *
 * Staging is the widest because it is upstream of everything: a feature
 * visible in beta is necessarily visible in staging, which is where it was
 * tested first. Production is the narrowest.
 */
const CHANNEL_RANK: Record<BuildChannel, number> = {
  production: 0,
  beta: 1,
  staging: 2,
};

/**
 * Parse the baked channel string.
 *
 * Deliberately identical to Rust's `parse_release_channel`, including the
 * fail-safe: anything unrecognised — unset, empty, or a typo — is
 * production, the only direction that cannot hand a real user a prerelease
 * lane's behaviour. Casing and whitespace are tolerated because the value
 * comes from a workflow env line, where both are easy to introduce and
 * neither is meaningful.
 */
export function parseBuildChannel(raw: string | undefined | null): BuildChannel {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "staging") return "staging";
  if (value === "beta") return "beta";
  return "production";
}

/**
 * The channel this bundle was built for.
 *
 * `process.env.RELEASE_CHANNEL` is inlined by `next.config.ts` at build
 * time; in `pnpm dev` and under Vitest it is absent, so both behave as
 * production — a developer sees what a user sees unless they set the
 * variable themselves.
 */
export const BUILD_CHANNEL: BuildChannel = parseBuildChannel(
  process.env.RELEASE_CHANNEL,
);

/**
 * Whether a feature gated at `minimum` is visible on `channel`.
 *
 * `enabledOn("beta", "staging")` is true: staging is upstream of beta and
 * shows everything beta shows.
 */
export function isEnabledOn(minimum: BuildChannel, channel: BuildChannel): boolean {
  return CHANNEL_RANK[channel] >= CHANNEL_RANK[minimum];
}

/**
 * A feature flag that turns on from `minimum` outwards.
 *
 * `enabledFrom("beta")` → on in beta and staging, off in production.
 * `enabledFrom("staging")` → internal only.
 * `enabledFrom("production")` → on everywhere (say `true` instead).
 */
export function enabledFrom(minimum: BuildChannel): boolean {
  return isEnabledOn(minimum, BUILD_CHANNEL);
}

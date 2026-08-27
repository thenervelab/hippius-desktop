"use client";

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * IPC wrappers for update checks.
 *
 * These replace `@tauri-apps/plugin-updater`'s `check()` and
 * `downloadAndInstall()`, which cannot be used here: both read the single
 * `plugins.updater.endpoints` list compiled into `tauri.conf.json`, and the JS
 * `CheckOptions` has no way to override it (`headers`, `timeout`, `proxy`,
 * `target`, `allowDowngrades` only). A build has to ask its OWN release lane
 * for updates, and only Rust's `UpdaterExt::updater_builder().endpoints(..)`
 * can express that — see `src-tauri/src/updates.rs` for why asking the wrong
 * lane is a silent wrong-build install rather than a missing feature.
 */

/** The release lane a build came from. Mirrors Rust's `ReleaseChannel`. */
export type ReleaseChannel = "production" | "beta" | "staging";

/** An update the running channel is offering. Mirrors Rust's `AvailableUpdate`. */
export type AvailableUpdate = {
  version: string;
  currentVersion: string;
  notes: string;
  channel: ReleaseChannel;
};

/**
 * Download progress. `bytesTotal` is null when the asset is served without a
 * Content-Length, in which case render an indeterminate bar rather than
 * dividing by zero.
 */
export type DownloadProgress = {
  bytesDone: number;
  bytesTotal: number | null;
};

/**
 * Whether this build's own channel is offering a newer version.
 *
 * `null` means "nothing to install", which covers both up-to-date and a lane
 * that publishes no manifest at all (staging, installed by hand). Callers must
 * not treat the second case as an error — it is that lane's designed state.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  return invoke<AvailableUpdate | null>("check_for_update");
}

/**
 * Download and install the update this channel is offering.
 *
 * Does not relaunch — the caller decides when to restart. Rust re-checks the
 * manifest rather than reusing the handle from `checkForUpdate`, so a dialog
 * left open for an hour cannot install a version the user was never shown.
 */
export async function installUpdate(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const onProgressChannel = new Channel<DownloadProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<void>("install_update", { onProgress: onProgressChannel });
}

/** The lane this build came from, without a network round-trip. */
export async function currentReleaseChannel(): Promise<ReleaseChannel> {
  return invoke<ReleaseChannel>("current_release_channel");
}

/**
 * The running channel, the channel it can switch to, and what that channel is
 * currently publishing. Mirrors Rust's `ChannelStatus`.
 *
 * `target` is null on a lane that cannot switch (staging, installed by hand).
 * `targetVersion` is null when the target's manifest could not be read — an
 * offline machine, or a lane that has published nothing yet. Offer the switch
 * without naming a version rather than hiding it: "we could not reach the beta
 * channel" is a different message from "there is no beta".
 *
 * `blockedReason`, when set, is a user-facing sentence explaining why the
 * switch is refused — the target build cannot read state this one has written.
 */
export type ChannelStatus = {
  current: ReleaseChannel;
  target: ReleaseChannel | null;
  targetVersion: string | null;
  blockedReason: string | null;
};

/** Read the switch surface's state. Never throws on a network problem. */
export async function releaseChannelStatus(): Promise<ChannelStatus> {
  return invoke<ChannelStatus>("release_channel_status");
}

/**
 * Install the other channel's build.
 *
 * Does not relaunch — the caller does, after telling the user what happened.
 * Rust re-validates the target against its own switch rule rather than trusting
 * this argument, and re-checks the downgrade guard immediately before writing.
 */
export async function switchReleaseChannel(
  target: ReleaseChannel,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const onProgressChannel = new Channel<DownloadProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<void>("switch_release_channel", {
    target,
    onProgress: onProgressChannel,
  });
}

import type { ChannelStatus, ReleaseChannel } from "@/lib/tauri/updates";

/**
 * Copy and state for the channel-switch surfaces, as a pure resolver.
 *
 * Split from the components so the wording is unit-testable and the two
 * surfaces that show it — the address-menu item and the settings section —
 * cannot describe the same state differently.
 */

export type ChannelView = {
  /** Address-menu label. Never describes an action the item will not perform. */
  menuLabel: string;
  /** Dialog heading. */
  title: string;
  /** Dialog body. */
  description: string;
  /** Confirm button. */
  confirmText: string;
  /** Human name of the running lane, for the settings section. */
  currentLabel: string;
  /** Whether the switch can be offered at all. */
  canSwitch: boolean;
};

const CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  production: "Stable",
  beta: "Beta",
  staging: "Internal",
};

/**
 * What the beta channel actually is, in the user's terms.
 *
 * Deliberately says the features are NOT fully stabilized. This is the whole
 * point of the dialog: someone who opts in after reading it has been told, and
 * someone who would not want that has been given the chance to decline. Softer
 * wording turns a warning into marketing, which is why a test pins it.
 */
const JOIN_DESCRIPTION =
  "The beta channel follows the development work. You get the newest features first, and those features are not fully stabilized — expect rough edges and more frequent updates. You can go back to the stable version at any time from Settings.";

const LEAVE_DESCRIPTION =
  "You will move back to the stable version, which changes less often and is more thoroughly tested.";

/** Append the version being installed, when the target channel published one. */
function withVersion(base: string, status: ChannelStatus): string {
  if (status.installInPlace === false) {
    return status.targetVersion
      ? `${base} ${status.targetVersion} is available. ${status.manualInstallHint}`
      : `${base} ${status.manualInstallHint}`;
  }

  const restart = "Hippius will download the build and restart.";
  return status.targetVersion
    ? `${base} ${restart.replace("the build", status.targetVersion)}`
    : `${base} ${restart}`;
}

export function getChannelView(status: ChannelStatus): ChannelView {
  const currentLabel = CHANNEL_LABELS[status.current];
  const canSwitch = status.target !== null && status.blockedReason === null;
  const confirmText = status.installInPlace === false
    ? "Open GitHub Releases"
    : status.current === "beta"
      ? "Leave Beta"
      : "Switch to Beta";

  if (status.current === "beta") {
    return {
      menuLabel: "Leave Beta",
      title: "Leave the beta channel",
      // Returning to stable needs a restart notice, not a warning — the user is
      // moving toward the more tested build, not away from it.
      description: withVersion(LEAVE_DESCRIPTION, status),
      confirmText,
      currentLabel,
      canSwitch,
    };
  }

  return {
    menuLabel: "Explore Beta",
    title: "Explore the beta channel",
    description: withVersion(JOIN_DESCRIPTION, status),
    confirmText,
    currentLabel,
    canSwitch,
  };
}

export function channelLabel(channel: ReleaseChannel): string {
  return CHANNEL_LABELS[channel];
}

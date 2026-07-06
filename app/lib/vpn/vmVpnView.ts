import type { MeshStatus } from "./types";

// Pure presentation resolver for the per-VM VPN control, mirroring the repo's
// "pure resolver + unit test" pattern (e.g. getSidebarSearchView,
// getTraySyncSummary). Keeps the UI component declarative and the
// connect/disconnect/open affordance logic testable without a backend.

export type VmVpnPhase =
  | "unsupported" // build has no real engine
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface VmVpnView {
  phase: VmVpnPhase;
  /** Show/enable the Connect action. */
  canConnect: boolean;
  /** Show/enable the Disconnect action. */
  canDisconnect: boolean;
  /** Whether a VM connection can be opened now (peer connected). */
  canOpen: boolean;
  /** Human-readable status line; the error message for `error`. */
  message: string;
}

/**
 * Resolve the VM VPN control's view from the build capability + live status.
 *
 * `supported === false` (the default build with no `netbird-vpn` feature, or a
 * status fetch that hasn't landed) collapses to `unsupported` with every action
 * disabled — so the UI shows "VPN unavailable in this build" rather than
 * offering a Connect button that would fail. A null status (pre-fetch) is
 * treated as not-yet-connected once supported.
 */
export function resolveVmVpnView(
  supported: boolean,
  status: MeshStatus | null | undefined
): VmVpnView {
  if (!supported) {
    return {
      phase: "unsupported",
      canConnect: false,
      canDisconnect: false,
      canOpen: false,
      message: "VPN is not available in this build.",
    };
  }

  const kind = status?.kind ?? "disconnected";

  switch (kind) {
    case "connected":
      return {
        phase: "connected",
        canConnect: false,
        canDisconnect: true,
        canOpen: true,
        message: "Connected.",
      };
    case "connecting":
      return {
        phase: "connecting",
        canConnect: false,
        canDisconnect: false,
        canOpen: false,
        message: "Connecting…",
      };
    case "error":
      return {
        phase: "error",
        // Recoverable: allow retrying Connect from an error state.
        canConnect: true,
        canDisconnect: false,
        canOpen: false,
        message: status?.message ?? "VPN error.",
      };
    case "disconnected":
    default:
      return {
        phase: "disconnected",
        canConnect: true,
        canDisconnect: false,
        canOpen: false,
        message: "Not connected.",
      };
  }
}

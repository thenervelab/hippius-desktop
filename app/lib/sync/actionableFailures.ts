import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";

/**
 * Whether a snapshot's failed rows are ones the user actually has to act on.
 *
 * `failedFiles` counts every errored row, including failures Rust has already
 * judged self-resolving — today, a local file that vanished before upload
 * (`FileFailureKindPayload::Gone`). That classification happens ONLY in Rust
 * (`sync/projection/progress.rs::fixup_gone_only_failures`) and reaches the FE
 * as an explicit `statusVariant === "success"` on a snapshot that still carries
 * a non-zero `failedFiles` — a pairing hcfs-client's own `build_snapshot` never
 * produces, so trusting it changes nothing else.
 *
 * The widget, the tray popover and the tray icon each re-derived "failed" from
 * the raw count, which overrode that verdict and kept painting a cleared sync
 * red (H-080).
 */
export function hasActionableFailures(
  snapshot: Pick<SyncSnapshot, "failedFiles" | "statusVariant">,
): boolean {
  return snapshot.failedFiles > 0 && snapshot.statusVariant !== "success";
}

export default hasActionableFailures;

import type { AvailableUpdate } from "@/lib/tauri/updates";

/**
 * Whether the Update dialog should call install, or send the user to GitHub.
 *
 * Rust owns the decision (`installInPlace`). A `.deb` cannot be applied as
 * the current user; offering Install anyway downloads the package and fails
 * with Permission denied (os error 13).
 */
export type UpdateInstallPlan =
  | { kind: "in-place" }
  | { kind: "manual"; url: string; hint: string };

export function getUpdateInstallPlan(
  update: Pick<
    AvailableUpdate,
    "installInPlace" | "releasePageUrl" | "manualInstallHint"
  >,
): UpdateInstallPlan {
  if (update.installInPlace === false) {
    return {
      kind: "manual",
      url: update.releasePageUrl,
      hint: update.manualInstallHint,
    };
  }
  return { kind: "in-place" };
}

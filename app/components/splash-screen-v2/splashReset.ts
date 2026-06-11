/**
 * Pure decision for whether the boot splash should "rewind" itself to its
 * update-check beat because an update dialog has appeared.
 *
 * The splash uses this to pause/reset its progress while the updater dialog is
 * on screen during boot. The critical guard is `splashFullyComplete`: once the
 * splash has finished and handed off to the app, its `children` (the whole app)
 * are mounted and the splash is gone. Resetting at that point would flip
 * `isFullyComplete` back to `false`, unmounting the app behind the dialog's
 * full-screen overlay — so when the dialog is later closed nothing is left to
 * show and the window goes blank.
 *
 * This matters because the update dialog can be opened MANUALLY long after boot
 * (the profile menu, the tray "Check for Updates", a deep link). In every one
 * of those cases the splash is already complete and must stay out of the way.
 */
export interface SplashResetInputs {
  /** Is the updater dialog currently open? */
  updateDialogOpen: boolean;
  /** Has the splash advanced past its initial null phase? */
  hasActivePhase: boolean;
  /** Has the splash already finished its full boot sequence? */
  splashFullyComplete: boolean;
}

/**
 * Returns `true` only while the splash is still running its boot sequence and an
 * update dialog has opened over it. Always `false` once the splash is complete,
 * so a post-boot dialog (profile menu / tray / deep link) never tears down the
 * already-mounted app.
 */
export function shouldResetSplashForUpdateDialog({
  updateDialogOpen,
  hasActivePhase,
  splashFullyComplete,
}: SplashResetInputs): boolean {
  if (splashFullyComplete) return false;
  return updateDialogOpen && hasActivePhase;
}

"use client";

/**
 * SyncSetupPrompt is no longer needed.
 *
 * HCFS setup is now entirely user-driven:
 *  1. User selects a sync folder in the Files page
 *  2. If HCFS config (password) is missing, the HcfsSetupDialog is shown inline
 *  3. After entering the password, sync starts and a success toast appears
 *
 * This file is kept as a no-op to avoid breaking any lazy imports.
 */
export default function SyncSetupPrompt() {
  return null;
}

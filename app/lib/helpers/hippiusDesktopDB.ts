import { invoke } from "@tauri-apps/api/core";

/**
 * Clear local data on logout/reset.
 * Calls Rust backend to clear notifications and other local state.
 */
export async function clearHippiusDesktopDB() {
  try {
    await invoke("clear_all_notifications");
  } catch (error) {
    console.error("Failed to clear local data:", error);
  }
}

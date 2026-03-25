import { invoke } from "@tauri-apps/api/core";

type ViewMode = "list" | "card";

export async function getViewModePreference(): Promise<ViewMode> {
  try {
    const value = await invoke<string | null>("get_user_preference", {
      key: "file_view_preferences",
    });
    if (!value) return "list";
    try {
      const parsed = JSON.parse(value) as { viewMode?: ViewMode };
      return parsed.viewMode || "list";
    } catch {
      return "list";
    }
  } catch (error) {
    console.error("Failed to get view mode preference:", error);
    return "list";
  }
}

export async function saveViewModePreference(viewMode: ViewMode): Promise<void> {
  try {
    const value = JSON.stringify({ viewMode });
    await invoke("save_user_preference", {
      key: "file_view_preferences",
      value,
    });
  } catch (error) {
    console.error("Failed to save view mode preference:", error);
  }
}

export async function getUserPreference<T = unknown>(key: string): Promise<T | null> {
  try {
    const value = await invoke<string | null>("get_user_preference", { key });
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`Failed to parse preference for key ${key}:`, error);
      return null;
    }
  } catch (error) {
    console.error(`Failed to get preference for key ${key}:`, error);
    return null;
  }
}

export async function saveUserPreference<T = unknown>(key: string, value: T): Promise<void> {
  try {
    const preferenceValue = JSON.stringify(value);
    await invoke("save_user_preference", { key, value: preferenceValue });
  } catch (error) {
    console.error(`Failed to save preference for key ${key}:`, error);
  }
}

// ── Last browse directory ──────────────────────────────────────────────────────
// Remembers the last directory the user browsed to in file/folder pickers,
// similar to how Chrome remembers the last download/upload location.

const LAST_BROWSE_DIR_KEY = "last_browse_directory";

/**
 * Returns the best default path for a file/folder picker dialog.
 * Fallback chain: last browse directory → home directory → undefined (OS default).
 */
export async function getLastBrowseDirectory(): Promise<string | undefined> {
  try {
    const saved = await getUserPreference<string>(LAST_BROWSE_DIR_KEY);
    if (saved) return saved;
  } catch {
    // Preference lookup failed; fall through
  }
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    return await homeDir();
  } catch {
    return undefined;
  }
}

/**
 * Saves the directory the user just browsed to so subsequent dialogs open there.
 * For file selections, pass the file path — the parent directory is extracted automatically.
 * For folder selections, pass the folder path directly.
 */
export async function saveLastBrowseDirectory(
  selectedPath: string,
  isFile: boolean = false
): Promise<void> {
  try {
    let dir = selectedPath;
    if (isFile) {
      const { dirname } = await import("@tauri-apps/api/path");
      dir = await dirname(selectedPath);
    }
    await saveUserPreference(LAST_BROWSE_DIR_KEY, dir);
  } catch (error) {
    console.error("Failed to save last browse directory:", error);
  }
}

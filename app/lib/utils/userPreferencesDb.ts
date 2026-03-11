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

import { invoke } from "@tauri-apps/api/core";

export async function isOnboardingDone(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_onboarding_done");
  } catch (err) {
    console.error("Error checking onboarding status:", err);
    return false;
  }
}

export async function setOnboardingDone(done: boolean = true): Promise<boolean> {
  try {
    await invoke("set_onboarding_done", { done });
    return true;
  } catch (err) {
    console.error("Failed to update onboarding status:", err);
    return false;
  }
}

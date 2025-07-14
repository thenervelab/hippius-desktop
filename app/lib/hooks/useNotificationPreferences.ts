import { useState, useEffect, useCallback } from "react";
import {
  getNotificationPreferences,
  updateAllNotificationPreferences
} from "@/app/lib/helpers/notificationsDb";

export type NotificationPreference = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
};

export function useNotificationPreferences() {
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPreferences = useCallback(async () => {
    setLoading(true);
    try {
      const prefs = await getNotificationPreferences();
      setPreferences(prefs);
    } catch (error) {
      console.error("Failed to load notification preferences:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const savePreferences = useCallback(
    async (prefMap: Record<string, boolean>) => {
      try {
        await updateAllNotificationPreferences(prefMap);
        await loadPreferences(); // Reload preferences after saving
        return true;
      } catch (error) {
        console.error("Failed to save notification preferences:", error);
        return false;
      }
    },
    [loadPreferences]
  );

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  return {
    preferences,
    loading,
    loadPreferences,
    savePreferences
  };
}

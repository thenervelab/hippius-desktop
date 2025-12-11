import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/lib/config";

export interface NotificationSettings {
  email_enabled: boolean;
  low_credit_alerts: boolean;
  zero_balance_alerts: boolean;
  file_status_updates: boolean;
  marketing_emails: boolean;
}

const NOTIFICATION_SETTINGS_KEY = "notification-settings";

// Fetch notification settings
async function fetchNotificationSettings(
  token: string
): Promise<NotificationSettings> {
  const response = await fetch(
    `${API_CONFIG.baseUrl}/api/notifications/settings/`,
    {
      method: "GET",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to fetch notification settings");
  }

  return response.json();
}

// Update notification settings (PATCH for partial updates)
async function updateNotificationSettings(
  token: string,
  settings: Partial<NotificationSettings>
): Promise<NotificationSettings> {
  const response = await fetch(
    `${API_CONFIG.baseUrl}/api/notifications/settings/`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to update notification settings");
  }

  return response.json();
}

export const useNotificationSettings = () => {
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  // Query to fetch settings
  const {
    data: settings,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [NOTIFICATION_SETTINGS_KEY, oauthSession?.email],
    queryFn: () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }
      return fetchNotificationSettings(oauthSession.token);
    },
    enabled: !!oauthSession?.token,
    staleTime: 300000, // 5 minutes
    retry: 1,
  });

  // Mutation to update settings
  const updateMutation = useMutation({
    mutationFn: (newSettings: Partial<NotificationSettings>) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }
      return updateNotificationSettings(oauthSession.token, newSettings);
    },
    onSuccess: (data) => {
      // Update the cache with new data
      queryClient.setQueryData(
        [NOTIFICATION_SETTINGS_KEY, oauthSession?.email],
        data
      );
    },
  });

  return {
    settings,
    isLoading,
    error,
    refetch,
    updateSettings: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
  };
};

export default useNotificationSettings;

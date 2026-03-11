import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";

export interface NotificationSettings {
  email_enabled: boolean;
  low_credit_alerts: boolean;
  zero_balance_alerts: boolean;
  file_status_updates: boolean;
  marketing_emails: boolean;
}

const NOTIFICATION_SETTINGS_KEY = "notification-settings";

export const useNotificationSettings = () => {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  // Query to fetch settings
  const {
    data: settings,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [NOTIFICATION_SETTINGS_KEY, polkadotAddress],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }
      return invoke<NotificationSettings>("get_notification_settings", {
        accountId: polkadotAddress,
      });
    },
    enabled: !!polkadotAddress,
    staleTime: 300000,
    retry: 1,
  });

  // Mutation to update settings
  const updateMutation = useMutation({
    mutationFn: async (newSettings: Partial<NotificationSettings>) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }
      return invoke<NotificationSettings>("update_notification_settings", {
        accountId: polkadotAddress,
        settings: newSettings,
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(
        [NOTIFICATION_SETTINGS_KEY, polkadotAddress],
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

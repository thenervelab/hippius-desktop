import { useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useInvokeQuery } from "./useInvokeQuery";
import { useInvokeMutation } from "./useInvokeMutation";

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
  } = useInvokeQuery<NotificationSettings>({
    command: "get_notification_settings",
    queryKey: (addr) => [NOTIFICATION_SETTINGS_KEY, addr],
    options: {
      staleTime: 300000,
      retry: 1,
    },
  });

  // Mutation to update settings
  const updateMutation = useInvokeMutation<
    NotificationSettings,
    Partial<NotificationSettings>
  >(
    {
      command: "update_notification_settings",
      params: (polkadotAddr, newSettings) => ({
        accountId: polkadotAddr,
        settings: newSettings,
      }),
    },
    {
      onSuccess: (data) => {
        queryClient.setQueryData(
          [NOTIFICATION_SETTINGS_KEY, polkadotAddress],
          data
        );
      },
    }
  );

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

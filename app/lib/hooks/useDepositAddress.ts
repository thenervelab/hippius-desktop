import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/lib/config";

export default function useDepositAddress() {
  const { oauthSession } = useWalletAuth();

  return useQuery({
    queryKey: ["get-deposit-address", oauthSession?.userId],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        `${API_CONFIG.baseUrl}/api/billing/substrate-address/`,
        {
          method: "GET",
          headers: {
            Authorization: `Token ${oauthSession.token}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        toast.error("Failed to fetch deposit address");
        throw new Error(`Failed to fetch deposit address: ${response.status}`);
      }

      const data = await response.json();

      if (!data.ss58_address) {
        console.error("Invalid response data:", data);
        throw new Error("No ss58_address in response");
      }

      return data.ss58_address as string;
    },
    enabled: !!oauthSession?.token,
  });
}

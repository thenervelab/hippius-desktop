import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getAuthHeaders } from "@/app/lib/services/authService";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";
import { API_CONFIG } from "@/app/lib/helpers/sessionStore";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export default function useDepositAddress() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["get-deposit-address", polkadotAddress],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No User Address");
      }

      // Ensure we have valid auth before proceeding
      const authOk = await ensureBillingAuth();
      if (!authOk.ok) {
        throw new Error(authOk.error || "Not authenticated");
      }

      const headers = await getAuthHeaders();
      if (!headers) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(`${API_CONFIG.baseUrl}/api/billing/substrate-address/`, {
        headers,
      });

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
    enabled: !!polkadotAddress,
  });
}

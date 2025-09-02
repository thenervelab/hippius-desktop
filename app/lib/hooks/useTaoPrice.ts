import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/app/lib/helpers/sessionStore";
import { getAuthHeaders } from "@/lib/services/authService";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";

interface TaoPrice {
  price_usd: string;
  block_number: number;
  created_at: string;
  percent_change_24h?: string;
}

const useTaoPrice = () => {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["get-tao-price"],
    refetchInterval: 60000,
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

      const response = await fetch(
        `${API_CONFIG.baseUrl}/api/billing/latest-tao-price`,
        {
          headers
        }
      );

      if (!response.ok) {
        toast.error("Failed to fetch TAO price");
        throw new Error("Failed to fetch TAO price");
      }

      const data = await response.json();
      return data as TaoPrice;
    },
    enabled: !!polkadotAddress
  });
};

export default useTaoPrice;

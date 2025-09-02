import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/app/lib/helpers/sessionStore";
import { getAuthHeaders } from "@/lib/services/authService";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";

const useTopUpBalance = () => {
  const { polkadotAddress } = useWalletAuth();
  const router = useRouter();

  return useMutation({
    mutationKey: ["topUpBalance"],
    mutationFn: async (amount: number) => {
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

      const response = await fetch(`${API_CONFIG.baseUrl}/api/billing/top-up`, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_address: polkadotAddress, amount }),
      });

      if (!response.ok) {
        toast.error("Failed to top up your balance!");
        throw new Error("API request failed");
      }

      const data = await response.json();

      if (data.url) {
        router.push(data.url);
      }

      return data;
    }
  });
};

export default useTopUpBalance;

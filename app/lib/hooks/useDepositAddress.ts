import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export default function useDepositAddress() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["get-deposit-address", polkadotAddress],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const data = await invoke<{ ss58_address: string }>(
        "get_deposit_address",
        { accountId: polkadotAddress }
      );

      if (!data.ss58_address) {
        console.error("Invalid response data:", data);
        throw new Error("No ss58_address in response");
      }

      return data.ss58_address;
    },
    enabled: !!polkadotAddress,
  });
}

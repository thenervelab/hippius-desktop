// lib/hooks/useUserReferrals.ts
import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface ReferralEvent {
  address: string;
  date: string;
  status: "Active";
  reward: string;
}

export interface UserReferralsData {
  referralHistory: ReferralEvent[];
  totalReferrals: number;
  totalRewards: string;
  referralCodes: string[];
}

const RPC_URL = "https://rpc.hippius.network";

export const useUserReferrals = () => {
  const { polkadotAddress } = useWalletAuth();

  return useQuery<UserReferralsData, Error>({
    queryKey: ["user-referrals", polkadotAddress] as const,
    enabled: Boolean(polkadotAddress),
    staleTime: 10 * 60_000, // 10 minutes
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No address provided");
      }

      // start with the defaults
      const dataToReturn: UserReferralsData = {
        referralHistory: [],
        totalReferrals: 0,
        totalRewards: "0",
        referralCodes: []
      };

      // 1) fetch on-chain data here if you need to populate
      //    referralHistory, totalReferrals, totalRewards
      //    e.g. via api.query.credits.*
      //    For now we leave them as defaults.

      // 2) fetch referralCodes via JSON-RPC
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "get_referral_codes",
          params: [polkadotAddress],
          id: 1
        })
      });
      if (!res.ok) {
        throw new Error(`RPC error ${res.status}`);
      }

      const rpc = (await res.json()) as {
        jsonrpc: string;
        result: number[][];
        error?: { code: number; message: string };
      };
      if (rpc.error) {
        throw new Error(rpc.error.message || "RPC returned an error");
      }

      // decode each array of byte-values into a UTF-8 string
      const decoder = new TextDecoder();
      dataToReturn.referralCodes = rpc.result.map((bytes) =>
        decoder.decode(new Uint8Array(bytes))
      );

      return dataToReturn;
    }
  });
};

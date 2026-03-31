import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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

interface ReferralLink {
  code: string;
  reward: string;
}

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

      const links = await invoke<ReferralLink[]>("get_referral_links", {
        address: polkadotAddress,
      });

      return {
        referralHistory: [],
        totalReferrals: 0,
        totalRewards: "0",
        referralCodes: links.map((l) => l.code),
      };
    },
  });
};

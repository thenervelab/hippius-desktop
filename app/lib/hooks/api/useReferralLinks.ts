"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export type ReferralLink = {
  code: string;
  reward: string;
};

export function useReferralLinks() {
  const { polkadotAddress } = useWalletAuth();

  const query = useQuery<ReferralLink[], Error>({
    queryKey: ["referralLinks", polkadotAddress],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!polkadotAddress) throw new Error("Wallet not ready");
      return invoke<ReferralLink[]>("get_referral_links", {
        address: polkadotAddress,
      });
    },
    enabled: Boolean(polkadotAddress),
  });

  return {
    links: query.data ?? [],
    loading: query.isFetching,
    reload: query.refetch,
  };
}

"use client";

import { useInvokeQuery } from "./useInvokeQuery";

export type ReferralLink = {
  code: string;
  reward: string;
};

export function useReferralLinks() {
  const query = useInvokeQuery<ReferralLink[]>({
    command: "get_referral_links",
    queryKey: (addr) => ["referralLinks", addr],
    params: (polkadotAddress) => ({ address: polkadotAddress }),
  });

  return {
    links: query.data ?? [],
    loading: query.isFetching,
    reload: query.refetch,
  };
}

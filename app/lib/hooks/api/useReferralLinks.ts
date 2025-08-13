/* eslint-disable @typescript-eslint/no-explicit-any */

"use client";

import { useQuery } from "@tanstack/react-query";

import { usePolkadotApi } from "@/lib/polkadot-api-context";

import { useWalletAuth } from "@/lib/wallet-auth-context";

import type { Bytes } from "@polkadot/types";

import { decodeBytesToString } from "@/lib/utils/formatters/decodeByteToString";

export type ReferralLink = {
  code: string;

  reward: string;
};

async function fetchReferralLinks(
  api: any,

  main: string
): Promise<ReferralLink[]> {
  // fetch your codes

  const entries: any = await api.query.credits.referralCodes.entries();

  const mine = entries.filter(
    ([, ownerOpt]: [any, any]) =>
      ownerOpt.isSome && ownerOpt.unwrap().toString() === main
  );

  // raw Bytes keys

  const codeKeys = mine.map(
    ([storageKey]: [any]) => storageKey.args[0] as Bytes
  );

  // decode to strings

  const raws = codeKeys.map((key: Bytes) => key.toU8a(true));

  const codes = raws.map(decodeBytesToString);

  // fetch rewards in one go

  const rewardOpts = await api.query.credits.referralCodeRewards.multi(
    codeKeys
  );

  // divide out 10^18

  const DECIMALS = BigInt(10) ** BigInt(18);

  return codes.map((code: string, i: number) => {
    const rawValue = BigInt(rewardOpts[i].toString());

    return {
      code,

      reward: (rawValue / DECIMALS).toString()
    };
  });
}

export function useReferralLinks() {
  const { api, isConnected } = usePolkadotApi();

  const { walletManager } = useWalletAuth();

  const main = walletManager?.polkadotPair.address;

  const query = useQuery<ReferralLink[], Error>({
    queryKey: ["referralLinks", main],

    queryFn: () => {
      if (!api || !main) throw new Error("API or wallet not ready");

      return fetchReferralLinks(api, main);
    },

    enabled: Boolean(api && isConnected && main)
  });

  return {
    links: query.data ?? [],

    loading: query.isFetching,

    reload: query.refetch
  };
}

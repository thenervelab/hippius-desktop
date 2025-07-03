"use client";

import { useEffect, useState, useCallback } from "react";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export type SubAccount = { address: string; role: string };

export function useSubAccounts() {
  const { api, isConnected } = usePolkadotApi();
  const { walletManager } = useWalletAuth();
  const [subs, setSubs] = useState<SubAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!api || !isConnected || !walletManager?.polkadotPair) return;
    setLoading(true);

    const main = walletManager.polkadotPair.address;
    const entries = await api.query.subAccount.subAccount.entries();
    const mine = entries.filter(
      ([, mainOpt]) => mainOpt.isSome && mainOpt.unwrap().toString() === main
    );

    const resolved = await Promise.all(
      mine.map(async ([storageKey]) => {
        const sub = storageKey.args[0].toString();
        const roleOpt = await api.query.subAccount.subAccountRole(sub);
        return {
          address: sub,
          role: roleOpt.isSome ? roleOpt.unwrap().toString() : "",
        };
      })
    );

    setSubs(resolved);
    setLoading(false);
  }, [api, isConnected, walletManager]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { subs, loading, reload };
}

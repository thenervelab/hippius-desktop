import { atom } from "jotai";

import { ApiPromise } from "@polkadot/api";

interface PolkadotApiState {
  api: ApiPromise | null;
  isConnected: boolean;
  blockNumber: bigint | null;
}

export const polkadotApiAtom = atom<PolkadotApiState>({
  api: null,
  isConnected: false,
  blockNumber: null,
});

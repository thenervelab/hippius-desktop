import { atom } from "jotai";

interface PolkadotApiState {
  isConnected: boolean;
  isConnecting: boolean;
  blockNumber: bigint | null;
}

export const polkadotApiAtom = atom<PolkadotApiState>({
  isConnected: false,
  isConnecting: false,
  blockNumber: null,
});

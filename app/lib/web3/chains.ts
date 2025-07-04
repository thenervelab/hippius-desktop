import { Chain } from "viem";

export const hippiusChain: Chain = {
  id: 3799,
  name: "Hippius",
  nativeCurrency: {
    decimals: 18,
    name: "TAO",
    symbol: "TAO",
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.hippius.network"],
      webSocket: ["wss://rpc.hippius.network"],
    },
    public: {
      http: ["https://rpc.hippius.network"],
      webSocket: ["wss://rpc.hippius.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "HippiusScan",
      url: "https://scan.hippius.io",
    },
  },
  contracts: {
    profile: {
      address: "0x0000000000000000000000000000000000000826",
    },
  },
  testnet: false,
  fees: {},
};

export const hippiusChainHex = `0x${hippiusChain.id.toString(16)}`;

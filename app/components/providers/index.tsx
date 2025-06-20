"use client";

import { ReactNode } from "react";
import { ParallaxProvider } from "react-scroll-parallax";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { useHydrateAtoms } from "jotai/react/utils";
import { queryClientAtom } from "jotai-tanstack-query";

import { PolkadotApiProvider } from "@/lib/polkadot-api-context";

const queryClient = new QueryClient();

const HydrateAtoms: React.FC<{ children: ReactNode }> = ({ children }) => {
  useHydrateAtoms(new Map([[queryClientAtom, queryClient]]));
  return children;
};

const Providers: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>
        <HydrateAtoms>
          <PolkadotApiProvider>
            <ParallaxProvider>{children}</ParallaxProvider>
          </PolkadotApiProvider>
        </HydrateAtoms>
      </JotaiProvider>
    </QueryClientProvider>
  );
};

export default Providers;

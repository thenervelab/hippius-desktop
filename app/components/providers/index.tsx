"use client";

import { ReactNode, useEffect } from "react";
import { ParallaxProvider } from "react-scroll-parallax";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { useHydrateAtoms } from "jotai/react/utils";
import { queryClientAtom } from "jotai-tanstack-query";
import { ThemeProvider } from "next-themes";

import { PolkadotApiProvider } from "@/lib/polkadot-api-context";
import UpdateDownloadDialog from "@/app/components/updater/UpdateDownloadDialog";
import { appStore } from "@/lib/store/jotaiStore";
import { applyStoredAccent } from "@/lib/hooks/useAccentColor";

const queryClient = new QueryClient();

const HydrateAtoms: React.FC<{ children: ReactNode }> = ({ children }) => {
  useHydrateAtoms(new Map([[queryClientAtom, queryClient]]));
  return children;
};

const Providers: React.FC<{ children: ReactNode }> = ({ children }) => {
  useEffect(() => {
    applyStoredAccent();
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={appStore}>
          <HydrateAtoms>
            <PolkadotApiProvider>
              <ParallaxProvider>{children}</ParallaxProvider>
              <UpdateDownloadDialog />
            </PolkadotApiProvider>
          </HydrateAtoms>
        </JotaiProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
};

export default Providers;

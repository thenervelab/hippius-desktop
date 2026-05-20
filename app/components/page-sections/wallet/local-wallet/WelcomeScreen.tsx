"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { ArrowRight } from "lucide-react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

/* Entry screen of the local-wallet onboarding flow.
 *
 * Shown when no local wallet exists yet. The user picks one of:
 *   1. Create a brand-new wallet (generates a fresh mnemonic).
 *   2. Import an existing wallet from a 12/24-word mnemonic.
 *
 * The choice routes via `setupStep` — the orchestrator
 * (`LocalWalletSetup`) renders the matching screen next. No mnemonic is
 * collected here; the legacy `feature/wallet-updates` implementation had a
 * top-level mnemonic input on this screen that wrote to sessionStorage,
 * which we drop in favour of in-memory state owned by the orchestrator. */

const WelcomeScreen: React.FC = () => {
  const { setSetupStep } = useLocalWallet();

  return (
    <div className="flex flex-col items-center w-full max-w-[430px] mx-auto px-4 pt-16 pb-8">
      <div className="relative flex items-center justify-center mb-8 size-[100px]">
        <div className="absolute inset-0 size-full rounded-full border border-grey-90 dark:border-black-300" />
        <Icons.SplashHippiusLogo className="size-14 z-10" />
      </div>

      <h1 className="text-2xl font-semibold text-grey-10 dark:text-grey-light-100 mb-2 text-center">
        Welcome to Hippius Wallet
      </h1>
      <p className="text-base text-grey-60 dark:text-grey-dark-600 text-center mb-8">
        Create a new wallet or import an existing one to get started.
      </p>

      <div className="w-full space-y-3">
        <Button
          variant="primary"
          size="auto"
          className="w-full h-12 rounded-[8px] text-[15px] font-medium tracking-[-0.3px] gap-2"
          onClick={() => setSetupStep("create-mnemonic")}
        >
          Create New Wallet
          <ArrowRight className="size-4 shrink-0" />
        </Button>

        <Button
          variant="defaultStable"
          size="auto"
          className="w-full h-12 rounded-[8px] text-[15px] font-medium tracking-[-0.3px] border border-grey-80 dark:border-[#494949] bg-white dark:bg-[#2a2a2a] dark:text-white gap-2"
          onClick={() => setSetupStep("import-wallet")}
        >
          Import Existing Wallet
          <ArrowRight className="size-4 shrink-0" />
        </Button>
      </div>
    </div>
  );
};

export default WelcomeScreen;

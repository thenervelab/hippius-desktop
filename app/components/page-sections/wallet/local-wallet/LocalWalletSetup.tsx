"use client";

import React, { useEffect, useState } from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { Icons } from "@/components/ui";

import WelcomeScreen from "./WelcomeScreen";
import CreateMnemonicScreen from "./CreateMnemonicScreen";
import ImportWalletScreen from "./ImportWalletScreen";
import CreatePasswordScreen from "./CreatePasswordScreen";

/* Orchestrates the no-wallet onboarding flow.
 *
 * Renders the matching screen for the current `setupStep` and owns the
 * transient in-progress state (the freshly-generated or pasted mnemonic).
 * Hoisting that state here keeps the secret in one component's memory
 * for the duration of the flow — when the user navigates away or the
 * orchestrator unmounts, the mnemonic goes with it. */

const LocalWalletSetup: React.FC = () => {
  const { setupStep, setSetupStep, isLoading, refreshWallets } =
    useLocalWallet();

  // The mnemonic the user is currently working with (from create OR
  // import). Lives only as long as this component is mounted.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);

  // If the orchestrator unmounts mid-flow, wipe the mnemonic. This is
  // a best-effort defence — once a string is in JS memory it sticks
  // around until the GC runs, but clearing the reference at least makes
  // the slot eligible for collection.
  useEffect(() => {
    return () => setPendingMnemonic(null);
  }, []);

  if (isLoading || setupStep === "loading") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Icons.HippiusLogoLoader className="size-16 animate-pulse text-primary-50 dark:text-primary-brand-dark" />
        <p className="mt-4 text-grey-50 dark:text-grey-dark-600">Loading wallet…</p>
      </div>
    );
  }

  switch (setupStep) {
    case "welcome":
      return <WelcomeScreen />;
    case "create-mnemonic":
      return (
        <CreateMnemonicScreen
          onContinue={(mnemonic) => {
            setPendingMnemonic(mnemonic);
            setSetupStep("create-password");
          }}
          onBack={() => setSetupStep("welcome")}
        />
      );
    case "import-wallet":
      return (
        <ImportWalletScreen
          onContinue={(mnemonic) => {
            setPendingMnemonic(mnemonic);
            setSetupStep("create-password");
          }}
          onBack={() => setSetupStep("welcome")}
        />
      );
    case "create-password":
      // If the user lands here without a pending mnemonic (e.g. a stale
      // step from a previous session) push them back to welcome rather
      // than render a broken screen.
      if (!pendingMnemonic) {
        setSetupStep("welcome");
        return null;
      }
      return (
        <CreatePasswordScreen
          mnemonic={pendingMnemonic}
          onCreated={() => {
            setPendingMnemonic(null);
            // refreshWallets+setSetupStep("ready") already happen inside
            // createWallet, but call refresh again here defensively so any
            // race between the IPC return and the FE's react-query caches
            // resolves cleanly.
            void refreshWallets();
          }}
          onBack={() => setSetupStep("welcome")}
        />
      );
    case "enter-password":
      // Reserved for the unlock-after-restart flow (not yet wired in
      // this step). Currently we just fall back to welcome so the user
      // never sees a blank screen if something routes them here.
      setSetupStep("welcome");
      return null;
    case "ready":
      // The wallet exists — the parent gate component should be rendering
      // the regular wallet UI, not this orchestrator. Render nothing as
      // a safety net so a transient state never produces a flash.
      return null;
    default:
      return <WelcomeScreen />;
  }
};

export default LocalWalletSetup;

"use client";

import React, { useEffect, useState } from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { Icons } from "@/components/ui";

import WelcomeScreen from "./WelcomeScreen";
import CreateMnemonicScreen from "./CreateMnemonicScreen";
import ImportWalletScreen from "./ImportWalletScreen";
import CreatePasswordScreen from "./CreatePasswordScreen";

const LocalWalletSetup: React.FC = () => {
  const { setupStep, setSetupStep, isLoading, refreshWallets } =
    useLocalWallet();

  // Owned here (not in context) so the mnemonic is scoped to this
  // orchestrator and gets dropped on unmount.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);

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
      return (
        <WelcomeScreen
          onCreateNew={() => setSetupStep("create-mnemonic")}
          onImport={() => setSetupStep("import-wallet")}
          onAccessKeyContinue={(mnemonic) => {
            setPendingMnemonic(mnemonic);
            setSetupStep("create-password");
          }}
        />
      );
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
      // Stale step landing without a mnemonic in flight — restart.
      if (!pendingMnemonic) {
        setSetupStep("welcome");
        return null;
      }
      return (
        <CreatePasswordScreen
          mnemonic={pendingMnemonic}
          onCreated={() => {
            setPendingMnemonic(null);
            void refreshWallets();
          }}
          onBack={() => setSetupStep("welcome")}
        />
      );
    case "enter-password":
      // Reserved for the unlock-after-restart flow; not wired yet.
      setSetupStep("welcome");
      return null;
    case "ready":
      return null;
    default:
      return (
        <WelcomeScreen
          onCreateNew={() => setSetupStep("create-mnemonic")}
          onImport={() => setSetupStep("import-wallet")}
          onAccessKeyContinue={(mnemonic) => {
            setPendingMnemonic(mnemonic);
            setSetupStep("create-password");
          }}
        />
      );
  }
};

export default LocalWalletSetup;

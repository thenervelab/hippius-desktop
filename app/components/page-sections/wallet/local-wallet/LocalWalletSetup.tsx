"use client";

import React from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import WelcomeScreen from "./WelcomeScreen";
import CreateMnemonicScreen from "./CreateMnemonicScreen";
import CreatePasswordScreen from "./CreatePasswordScreen";
import EnterPasswordScreen from "./EnterPasswordScreen";
import ImportWalletScreen from "./ImportWalletScreen";
import { Icons } from "@/components/ui";

/**
 * Main component that orchestrates the wallet setup flow
 */
const LocalWalletSetup: React.FC = () => {
  const { setupStep, isLoading } = useLocalWallet();

  // Loading state
  if (isLoading || setupStep === "loading") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Icons.HippiusLogoLoader className="size-16 animate-pulse text-primary-50" />
        <p className="mt-4 text-grey-50">Loading wallet...</p>
      </div>
    );
  }

  // Render appropriate screen based on setup step
  switch (setupStep) {
    case "welcome":
      return <WelcomeScreen />;
    case "create-mnemonic":
      return <CreateMnemonicScreen />;
    case "create-password":
      return <CreatePasswordScreen />;
    case "enter-password":
      return <EnterPasswordScreen />;
    case "import-wallet":
      return <ImportWalletScreen />;
    case "ready":
      // This shouldn't render - the parent should show wallet dashboard
      return null;
    default:
      return <WelcomeScreen />;
  }
};

export default LocalWalletSetup;

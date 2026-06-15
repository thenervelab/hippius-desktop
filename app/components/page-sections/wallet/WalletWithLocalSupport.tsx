"use client";

import React from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import LocalWalletSetup from "./local-wallet/LocalWalletSetup";

interface WalletWithLocalSupportProps {
  children: React.ReactNode;
}

const WalletWithLocalSupport: React.FC<WalletWithLocalSupportProps> = ({
  children,
}) => {
  const { setupStep, hasWallets, isLoading } = useLocalWallet();

  // Render the onboarding orchestrator during initial load too — its
  // own "loading" branch shows a spinner so the welcome screen never
  // flashes before the IPC resolves.
  if (isLoading) {
    return <LocalWalletSetup />;
  }

  if (!hasWallets || setupStep !== "ready") {
    return <LocalWalletSetup />;
  }

  return <>{children}</>;
};

export default WalletWithLocalSupport;

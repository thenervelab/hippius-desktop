"use client";

import React from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import LocalWalletSetup from "./local-wallet/LocalWalletSetup";

/* Gate component for the wallet page.
 *
 * - When the user has no local wallet yet, renders the onboarding flow
 *   (`LocalWalletSetup`).
 * - When a wallet exists, renders the regular wallet UI passed in
 *   `children`.
 *
 * `setupStep === "ready"` is the green-lit state; everything else means
 * the user is still mid-onboarding (or the context is still loading
 * `local_wallet_has_any` on first paint). */

interface WalletWithLocalSupportProps {
  children: React.ReactNode;
}

const WalletWithLocalSupport: React.FC<WalletWithLocalSupportProps> = ({
  children,
}) => {
  const { setupStep, hasWallets, isLoading } = useLocalWallet();

  // First paint: hasWallets defaults to false because the IPC hasn't
  // resolved yet. Show the loading shell instead of flashing the
  // onboarding "welcome" screen.
  if (isLoading) {
    return <LocalWalletSetup />;
  }

  if (!hasWallets || setupStep !== "ready") {
    return <LocalWalletSetup />;
  }

  return <>{children}</>;
};

export default WalletWithLocalSupport;

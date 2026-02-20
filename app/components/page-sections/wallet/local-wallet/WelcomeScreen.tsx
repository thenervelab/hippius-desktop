"use client";

import React, { useState } from "react";
import { CardButton, Icons, Input, Graphsheet } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import { ArrowRight, AlertCircle } from "lucide-react";

/**
 * Welcome screen for wallet setup
 * User can enter existing mnemonic or navigate to create/import
 */
const WelcomeScreen: React.FC = () => {
  const { setSetupStep } = useLocalWallet();
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleContinue = () => {
    const trimmed = mnemonic.trim();
    if (!trimmed) {
      setError("Please enter your mnemonic");
      return;
    }

    if (!isMnemonicValid(trimmed)) {
      setError("Invalid mnemonic phrase. Please check and try again.");
      return;
    }

    // Store mnemonic and go to password screen
    // We'll pass mnemonic through the context in the next step
    sessionStorage.setItem("temp_mnemonic", trimmed);
    setSetupStep("enter-password");
  };

  const handleCreateNew = () => {
    setSetupStep("create-mnemonic");
  };

  const handleImport = () => {
    setSetupStep("import-wallet");
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[430px] mx-auto px-4 pt-16 pb-8">
      {/* Logo with Graphsheet background */}
      <div className="relative flex items-center justify-center mb-8 size-[100px]">
        <Graphsheet className="absolute inset-0 size-full rounded-full border border-grey-90" />
        <Icons.SplashHippiusLogo className="size-14 z-10" />
      </div>

      {/* Title */}
      <h1 className="text-2xl font-semibold text-grey-10 mb-2">
        Welcome to Hippius Wallet
      </h1>
      <p className="text-base text-grey-60 text-center mb-8">
        Enter your wallet mnemonic to continue or create a new wallet
      </p>

      {/* Mnemonic Input */}
      <div className="w-full mb-6">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Mnemonic
        </label>
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
            <Icons.Key className="size-5" />
          </div>
          <Input
            type="password"
            value={mnemonic}
            onChange={(e) => {
              setMnemonic(e.target.value);
              setError(null);
            }}
            placeholder="Enter mnemonic"
            className="w-full h-14 pl-12 text-grey-10"
          />
        </div>
        {error && (
          <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-2">
            <AlertCircle className="size-4" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Continue Button */}
      <CardButton
        className="w-full h-12 mb-6"
        onClick={handleContinue}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          Next
          <ArrowRight className="size-5" />
        </div>
      </CardButton>

      {/* Divider with options */}
      <div className="w-full space-y-4">
        <button
          onClick={handleCreateNew}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors"
        >
          Don&apos;t have a wallet?{" "}
          <span className="font-semibold text-grey-10">Create New Wallet</span>
        </button>

        <button
          onClick={handleImport}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors block"
        >
          Have an existing wallet?{" "}
          <span className="font-semibold text-grey-10">Import Your Wallet</span>
        </button>
      </div>
    </div>
  );
};

export default WelcomeScreen;

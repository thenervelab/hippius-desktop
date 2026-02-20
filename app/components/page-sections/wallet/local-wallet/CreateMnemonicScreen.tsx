"use client";

import React, { useState, useEffect } from "react";
import { CardButton, Icons, Input, Graphsheet } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { ArrowRight, Copy, Check, AlertTriangle } from "lucide-react";

/**
 * Screen for creating a new wallet with generated mnemonic
 */
const CreateMnemonicScreen: React.FC = () => {
  const { generateMnemonic, setSetupStep } = useLocalWallet();
  const [mnemonic, setMnemonic] = useState("");
  const [walletName, setWalletName] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Generate mnemonic on mount
    const newMnemonic = generateMnemonic();
    setMnemonic(newMnemonic);
  }, [generateMnemonic]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const handleContinue = () => {
    // Store mnemonic and wallet name temporarily
    sessionStorage.setItem("temp_mnemonic", mnemonic);
    sessionStorage.setItem("temp_wallet_name", walletName || "My Wallet");
    setSetupStep("create-password");
  };

  const handleAccessExisting = () => {
    setSetupStep("welcome");
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
      <h1 className="text-2xl font-semibold text-grey-10 mb-8">
        Create New Wallet
      </h1>

      {/* Wallet Name Input */}
      <div className="w-full mb-6">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Wallet Name
        </label>
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
            <Icons.UserSquare className="size-5" />
          </div>
          <Input
            type="text"
            value={walletName}
            onChange={(e) => setWalletName(e.target.value)}
            placeholder="Choose a name for your wallet"
            className="w-full h-14 pl-12 text-grey-10"
          />
        </div>
      </div>

      {/* Mnemonic Display */}
      <div className="w-full mb-6">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Your Mnemonic
        </label>
        <div className="relative border border-grey-80 rounded-lg p-4 bg-grey-98">
          <div className="absolute left-4 top-4 text-grey-50">
            <Icons.Key className="size-5" />
          </div>
          <p className="pl-8 pr-10 text-grey-10 font-medium leading-relaxed">
            {mnemonic}
          </p>
          <button
            onClick={handleCopy}
            className="absolute right-4 top-4 text-grey-50 hover:text-grey-30 transition-colors"
          >
            {copied ? (
              <Check className="size-5 text-success-50" />
            ) : (
              <Copy className="size-5" />
            )}
          </button>
        </div>
      </div>

      {/* Warning */}
      <div className="w-full mb-6 p-4 bg-error-95 border border-error-80 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-5 text-error-60 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-grey-10 mb-2">IMPORTANT</p>
            <ul className="space-y-1 text-sm text-grey-30">
              <li className="flex items-start gap-2">
                <span className="text-error-60">→</span>
                Store this mnemonic in a secure password manager
              </li>
              <li className="flex items-start gap-2">
                <span className="text-error-60">→</span>
                Never share it with anyone
              </li>
              <li className="flex items-start gap-2">
                <span className="text-error-60">→</span>
                We <strong>cannot</strong> help you recover your account if you
                lose this key
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Continue Button */}
      <CardButton className="w-full h-12 mb-6" onClick={handleContinue}>
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          Set Mnemonic
          <ArrowRight className="size-5" />
        </div>
      </CardButton>

      {/* Other Options */}
      <div className="w-full space-y-4 text-center">
        <button
          onClick={handleAccessExisting}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors"
        >
          Already have a wallet?{" "}
          <span className="font-semibold text-grey-10">Access Wallet</span>
        </button>

        <button
          onClick={handleImport}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors block w-full"
        >
          Have an existing wallet?{" "}
          <span className="font-semibold text-grey-10">Import Your Wallet</span>
        </button>
      </div>
    </div>
  );
};

export default CreateMnemonicScreen;

"use client";

import React, { useState } from "react";
import { CardButton, Icons } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasscodeInput from "./PasscodeInput";
import { ArrowRight, AlertCircle } from "lucide-react";
import { toast } from "sonner";

/**
 * Screen for setting passcode for a new wallet
 */
const CreatePasscodeScreen: React.FC = () => {
  const { createWallet, setSetupStep } = useLocalWallet();
  const [passcode, setPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleCreate = async () => {
    setError(null);

    // Validate passcode
    if (!passcode) {
      setError("Please enter a passcode");
      return;
    }

    if (passcode.length < 6) {
      setError("Passcode must be at least 6 characters");
      return;
    }

    if (passcode !== confirmPasscode) {
      setError("Passcodes do not match");
      return;
    }

    // Get stored mnemonic and wallet name
    const mnemonic = sessionStorage.getItem("temp_mnemonic");
    const walletName =
      sessionStorage.getItem("temp_wallet_name") || "My Wallet";

    if (!mnemonic) {
      setError("No mnemonic found. Please go back and generate one.");
      return;
    }

    setIsLoading(true);

    try {
      const success = await createWallet(walletName, mnemonic, passcode);

      if (success) {
        // Clear temporary storage
        sessionStorage.removeItem("temp_mnemonic");
        sessionStorage.removeItem("temp_wallet_name");
        toast.success("Wallet created successfully!");
      } else {
        setError("Failed to create wallet. Please try again.");
      }
    } catch (err) {
      console.error("Failed to create wallet:", err);
      setError(
        err instanceof Error ? err.message : "Failed to create wallet"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleAccessExisting = () => {
    sessionStorage.removeItem("temp_mnemonic");
    sessionStorage.removeItem("temp_wallet_name");
    setSetupStep("welcome");
  };

  const handleImport = () => {
    sessionStorage.removeItem("temp_mnemonic");
    sessionStorage.removeItem("temp_wallet_name");
    setSetupStep("import-wallet");
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[428px] mx-auto px-4 pt-16 pb-8">
      {/* Logo */}
      <div className="mb-8">
        <Icons.HippiusLogo className="size-16" />
      </div>

      {/* Title */}
      <h1 className="text-2xl font-semibold text-grey-10 mb-2">
        Create New Wallet
      </h1>
      <p className="text-base text-grey-60 text-center mb-8">
        Set a passcode to secure your wallet
      </p>

      {/* Passcode Inputs */}
      <div className="w-full space-y-4 mb-6">
        <PasscodeInput
          value={passcode}
          onChange={(val) => {
            setPasscode(val);
            setError(null);
          }}
          label="Passcode"
          placeholder="Enter your passcode"
          disabled={isLoading}
          autoFocus
        />

        <PasscodeInput
          value={confirmPasscode}
          onChange={(val) => {
            setConfirmPasscode(val);
            setError(null);
          }}
          label="Confirm Passcode"
          placeholder="Reenter passcode"
          disabled={isLoading}
          onSubmit={handleCreate}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Create Button */}
      <CardButton
        className="w-full h-12 mb-6"
        onClick={handleCreate}
        disabled={isLoading}
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Creating..." : "Create Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>

      {/* Other Options */}
      <div className="w-full space-y-4 text-center">
        <button
          onClick={handleAccessExisting}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors"
          disabled={isLoading}
        >
          Already have a wallet?{" "}
          <span className="font-semibold text-grey-10">Access Wallet</span>
        </button>

        <button
          onClick={handleImport}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors block w-full"
          disabled={isLoading}
        >
          Have an existing wallet?{" "}
          <span className="font-semibold text-grey-10">Import Wallet</span>
        </button>
      </div>
    </div>
  );
};

export default CreatePasscodeScreen;

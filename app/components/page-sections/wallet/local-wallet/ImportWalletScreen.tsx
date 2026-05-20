"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

interface ImportWalletScreenProps {
  onContinue: (mnemonic: string) => void;
  onBack: () => void;
}

const ImportWalletScreen: React.FC<ImportWalletScreenProps> = ({
  onContinue,
  onBack,
}) => {
  const { validateMnemonic, deriveAddress } = useLocalWallet();
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewAddress, setPreviewAddress] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(false);

  // 300ms debounce keeps the IPC off the keystroke path while still
  // feeling instant.
  useEffect(() => {
    const trimmed = mnemonic.trim();
    if (!trimmed) {
      setIsValid(false);
      setPreviewAddress(null);
      setError(null);
      return;
    }
    const timer = setTimeout(async () => {
      const ok = await validateMnemonic(trimmed);
      if (!ok) {
        setIsValid(false);
        setPreviewAddress(null);
        setError("Invalid access key. Check the words and order.");
        return;
      }
      setIsValid(true);
      setError(null);
      const addr = await deriveAddress(trimmed);
      setPreviewAddress(addr);
    }, 300);
    return () => clearTimeout(timer);
  }, [mnemonic, validateMnemonic, deriveAddress]);

  const handleContinue = () => {
    const trimmed = mnemonic.trim();
    if (!trimmed) {
      setError("Please enter your access key");
      return;
    }
    if (!isValid) {
      setError("Invalid access key. Check the words and order.");
      return;
    }
    onContinue(trimmed);
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[520px] mx-auto px-4 pt-12 pb-8">
      <h1 className="text-2xl font-semibold text-grey-10 dark:text-grey-light-100 mb-2 text-center">
        Import Existing Wallet
      </h1>
      <p className="text-base text-grey-60 dark:text-grey-dark-600 text-center mb-6 max-w-[420px]">
        Paste your 12 or 24-word access key to import an existing Hippius
        wallet onto this device.
      </p>

      <div className="w-full mb-2">
        <label className="text-[13px] font-medium text-grey-70 dark:text-grey-dark-800 mb-1.5 block">
          Access Key
        </label>
        <textarea
          value={mnemonic}
          onChange={(e) => {
            setMnemonic(e.target.value);
            setError(null);
          }}
          placeholder="word1 word2 word3 ..."
          rows={3}
          className="w-full rounded-[8px] border border-grey-80 dark:border-[#494949] bg-white dark:bg-[#1a1a1a] px-3 py-2.5 text-[14px] text-grey-10 dark:text-white placeholder:text-grey-60 dark:placeholder:text-grey-dark-600 outline-none focus:border-primary-50 dark:focus:border-primary-brand-dark resize-none"
        />
      </div>

      {error ? (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4">
          <AlertCircle className="size-4" />
          <span>{error}</span>
        </div>
      ) : previewAddress ? (
        <div className="w-full mb-4 rounded-[8px] border border-primary-50/40 bg-primary-50/10 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide font-medium text-primary-50 dark:text-primary-brand-dark mb-1">
            Derived address
          </p>
          <p className="font-mono text-[13px] text-grey-10 dark:text-white truncate">
            {previewAddress}
          </p>
        </div>
      ) : (
        <div className="w-full mb-4" />
      )}

      <div className="w-full flex gap-3">
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          className="flex-1 h-11 rounded-[6px] border border-grey-80 dark:border-[#494949] bg-white dark:bg-[#2a2a2a] dark:text-white text-[14px] font-medium"
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          size="auto"
          className="flex-1 h-11 rounded-[6px] text-[14px] font-medium tracking-[-0.28px]"
          onClick={handleContinue}
          disabled={!isValid}
        >
          Continue
        </Button>
      </div>
    </div>
  );
};

export default ImportWalletScreen;

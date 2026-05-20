"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

interface CreateMnemonicScreenProps {
  /** Called once the user confirms they've saved the mnemonic. Receives
   * the freshly-generated mnemonic so the next screen (password setup)
   * can hand it to `createWallet`. */
  onContinue: (mnemonic: string) => void;
  onBack: () => void;
}

/* Step 2 of the "create new wallet" flow.
 *
 * Generates a 12-word BIP-39 mnemonic via the Rust IPC, displays it in a
 * 3-column grid for the user to write down, and only enables "Continue"
 * once they've ticked the "I've saved it" checkbox. Mnemonic lives in
 * this component's React state — it never touches storage, never leaves
 * memory once the user navigates away. */

const CreateMnemonicScreen: React.FC<CreateMnemonicScreenProps> = ({
  onContinue,
  onBack,
}) => {
  const { generateMnemonic } = useLocalWallet();
  const [mnemonic, setMnemonic] = useState<string>("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsGenerating(true);
      try {
        const m = await generateMnemonic();
        if (!cancelled) setMnemonic(m);
      } catch (e) {
        console.error("Failed to generate mnemonic:", e);
        if (!cancelled) toast.error("Failed to generate recovery phrase");
      } finally {
        if (!cancelled) setIsGenerating(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [generateMnemonic]);

  const words = mnemonic.split(/\s+/).filter(Boolean);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      toast.success("Recovery phrase copied to clipboard");
      // Defensive: clear the clipboard intent flag after the toast lives
      // out its lifetime so the icon doesn't stay green forever.
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[520px] mx-auto px-4 pt-12 pb-8">
      <h1 className="text-2xl font-semibold text-grey-10 dark:text-grey-light-100 mb-2 text-center">
        Save Your Recovery Phrase
      </h1>
      <p className="text-base text-grey-60 dark:text-grey-dark-600 text-center mb-6 max-w-[420px]">
        Write down these 12 words in order and store them somewhere safe.
        They're the only way to recover this wallet if you lose access.
      </p>

      <div className="w-full rounded-[14px] border border-grey-80 dark:border-[#494949] bg-grey-light-700 dark:bg-[#1a1a1a] p-4 mb-3">
        {isGenerating ? (
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 12 }, (_, i) => (
              <div
                key={i}
                className="h-9 rounded-[6px] bg-grey-light-800 dark:bg-[#2a2a2a] animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {words.map((word, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-[6px] border border-grey-80 dark:border-[#494949] bg-white dark:bg-[#2a2a2a] px-2 py-1.5"
              >
                <span className="text-[11px] font-mono text-grey-50 dark:text-grey-dark-600 w-4 text-right">
                  {i + 1}
                </span>
                <span className="text-[13px] font-medium text-grey-10 dark:text-white">
                  {word}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={handleCopy}
        disabled={isGenerating || !mnemonic}
        className={cn(
          "self-end inline-flex items-center gap-1.5 text-[13px] font-medium mb-4",
          "text-primary-50 hover:text-primary-40 dark:text-primary-brand-dark dark:hover:text-primary-65",
          "disabled:opacity-50",
        )}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        Copy to clipboard
      </button>

      <label className="w-full flex items-start gap-2.5 mb-6 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-[3px] size-4 shrink-0 rounded border-grey-80 text-primary-50 focus:ring-primary-50"
        />
        <span className="text-[13px] text-grey-60 dark:text-grey-dark-600">
          I've saved my recovery phrase somewhere safe. I understand that
          Hippius cannot recover it if I lose access.
        </span>
      </label>

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
          onClick={() => onContinue(mnemonic)}
          disabled={!acknowledged || isGenerating || !mnemonic}
        >
          Continue
        </Button>
      </div>
    </div>
  );
};

export default CreateMnemonicScreen;

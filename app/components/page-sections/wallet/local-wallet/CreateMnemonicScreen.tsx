"use client";

import React, { useEffect, useState } from "react";
import { ArrowRight, Check, Copy, Plus, User } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { Decoration, OctagonAlert, ShieldSecurity } from "@/components/ui/icons";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

const cornerTextureLight = getDiagonalTextureSvgBackgroundImage({
  opacity: 0.21,
});
const cornerTextureDark = getDiagonalTextureSvgBackgroundImage({
  color: "white",
  opacity: 0.1,
});

interface CreateMnemonicScreenProps {
  onContinue: (mnemonic: string, name: string) => void;
  onBack: () => void;
}

const CreateMnemonicScreen: React.FC<CreateMnemonicScreenProps> = ({
  onContinue,
  onBack,
}) => {
  const { generateMnemonic, setSetupStep } = useLocalWallet();
  const [mnemonic, setMnemonic] = useState("");
  const [walletName, setWalletName] = useState("");
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
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
    })();
    return () => {
      cancelled = true;
    };
  }, [generateMnemonic]);

  const handleCopy = async () => {
    if (!mnemonic) return;
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      toast.success("Recovery phrase copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const canContinue =
    walletName.trim().length > 0 && !isGenerating && !!mnemonic;

  const handleContinue = () => {
    if (!canContinue) return;
    onContinue(mnemonic, walletName.trim());
  };

  return (
    <div className="flex flex-1 w-full items-center justify-center px-4 py-6 mt-[14px] overflow-hidden rounded-[8px] border border-[#E3E3E3] dark:border-[#313131] bg-white dark:bg-[#1a1a1a]">
      <div className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-screen h-screen bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-screen h-screen bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-screen h-screen bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-screen h-screen bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />

        <BackgroundContainer
          className="relative w-full max-w-[594px]"
          fillClassName="fill-[#f9f9f9] dark:fill-[#202020]"
          strokeClassName="stroke-[#b3b3b3] dark:stroke-[#6c6c6c]"
          borderClassName="bg-transparent dark:bg-transparent p-0 sm:p-0"
          contentClassName="flex justify-center"
          decorationLineColor="rgba(151, 151, 151, 0.17)"
          shellClassName={cn(
            "w-full min-w-0 max-w-[494px]",
            "bg-white dark:bg-[#1a1a1a]",
            "p-3 sm:p-3 rounded-[8px] sm:rounded-[8px]",
          )}
          cardClassName={cn(
            "w-full min-w-0 max-w-full",
            "p-4 gap-[26px] items-stretch",
            "rounded-[10px] sm:rounded-[10px]",
            "bg-white dark:bg-[#161616]",
            "shadow-[0px_350px_98px_0px_rgba(0,0,0,0),0px_224px_90px_0px_rgba(0,0,0,0.01),0px_126px_76px_0px_rgba(0,0,0,0.03),0px_56px_56px_0px_rgba(0,0,0,0.05),0px_14px_31px_0px_rgba(0,0,0,0.06)]",
          )}
        >
          <div className="flex flex-col items-center gap-[19px]">
            <div className="relative flex items-center justify-center size-[56px] shrink-0">
              {/* Shared brand-blue grid decoration — already mode-aware
                  (radial white-fade in light, blurred ellipse mask in
                  dark) — used behind logo badges in other dialogs. */}
              <Decoration
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full"
              />
              <div className="relative flex items-center justify-center size-[40px] rounded-[10px] bg-primary-50">
                <Plus className="size-5 text-white" strokeWidth={2.5} />
              </div>
            </div>

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-[24px] font-medium leading-[32px] text-grey-10 dark:text-grey-light-100">
                Create New Wallet
              </h1>
              <p className="max-w-[424px] text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-50 dark:text-grey-dark-500">
                Enter your wallet mnemonic to continue or create a new wallet
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5">
              <label
                htmlFor="wallet-name"
                className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600"
              >
                Wallet Name
              </label>
              <Input
                id="wallet-name"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="Choose a name for your wallet"
                autoComplete="off"
                startAdornment={<User className="size-5 sm:size-6" />}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleContinue();
                  }
                }}
              />
            </div>

            <div className="flex flex-col gap-2.5">
              <label className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600">
                Your Access Key
              </label>
              {/* Readonly mnemonic display styled to match the Input
                  pill, with a leading shield icon and a trailing copy
                  affordance. */}
              <div
                className={cn(
                  "flex items-start gap-3 rounded-[8px] border px-3 py-3 min-h-[54px]",
                  "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-[#1a1a1a]",
                )}
              >
                <ShieldSecurity className="size-5 sm:size-6 shrink-0 mt-0.5 text-grey-50 dark:text-grey-dark-600" />
                <span
                  className={cn(
                    "flex-1 text-[16px] font-medium leading-[22px] tracking-[-0.32px] break-words",
                    "text-grey-10 dark:text-grey-light-100",
                    isGenerating && "text-grey-50",
                  )}
                >
                  {isGenerating ? "Generating..." : mnemonic}
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={isGenerating || !mnemonic}
                  className="shrink-0 mt-0.5 text-grey-50 dark:text-grey-dark-600 hover:text-grey-10 dark:hover:text-grey-light-100 disabled:opacity-50"
                  aria-label="Copy access key"
                >
                  {copied ? (
                    <Check className="size-5" />
                  ) : (
                    <Copy className="size-5" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <OctagonAlert className="size-5 text-[#F5A623]" />
                <span className="text-[14px] font-bold tracking-[0.5px] text-grey-10 dark:text-grey-light-100">
                  IMPORTANT
                </span>
              </div>
              <ul className="flex flex-col gap-2 pl-1">
                <li className="flex items-start gap-2.5 text-[14px] leading-[20px] text-grey-50 dark:text-grey-dark-500">
                  <ArrowRight className="size-4 shrink-0 mt-0.5 text-grey-50 dark:text-grey-dark-600" />
                  <span>Store this key in a secure password manager</span>
                </li>
                <li className="flex items-start gap-2.5 text-[14px] leading-[20px] text-grey-50 dark:text-grey-dark-500">
                  <ArrowRight className="size-4 shrink-0 mt-0.5 text-grey-50 dark:text-grey-dark-600" />
                  <span>Never share it with anyone</span>
                </li>
                <li className="flex items-start gap-2.5 text-[14px] leading-[20px] text-grey-50 dark:text-grey-dark-500">
                  <ArrowRight className="size-4 shrink-0 mt-0.5 text-grey-50 dark:text-grey-dark-600" />
                  <span>
                    We{" "}
                    <span className="font-semibold text-grey-10 dark:text-grey-light-100">
                      cannot
                    </span>{" "}
                    help you recover your account if you lose this key
                  </span>
                </li>
              </ul>
            </div>

            <Button
              type="button"
              variant="primary"
              size="auto"
              className={cn(
                "h-[52px] w-full rounded-[6px] gap-2.5 px-2.5",
                "text-[18px] font-normal tracking-[-0.36px] leading-[1.109]",
                !canContinue && "!bg-primary-50/40 hover:!bg-primary-50/40",
              )}
              onClick={handleContinue}
              disabled={!canContinue}
            >
              Continue
              <ArrowRight className="size-4 shrink-0" />
            </Button>
          </div>

          <div className="flex flex-col gap-2 text-center">
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                Already have a wallet?
              </span>
              <button
                type="button"
                onClick={onBack}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark hover:underline underline-offset-2 transition-colors"
              >
                Access Wallet
              </button>
            </p>
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                Have an existing wallet?
              </span>
              <button
                type="button"
                onClick={() => setSetupStep("import-wallet")}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark hover:underline underline-offset-2 transition-colors"
              >
                Import Your Wallet
              </button>
            </p>
          </div>
        </BackgroundContainer>
      </div>
    </div>
  );
};

export default CreateMnemonicScreen;

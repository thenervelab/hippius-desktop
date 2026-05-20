"use client";

import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { Key, WalletWelcomeLogo } from "@/components/ui/icons";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

const cornerTextureLight = getDiagonalTextureSvgBackgroundImage({
  opacity: 0.21,
});
const cornerTextureDark = getDiagonalTextureSvgBackgroundImage({
  color: "white",
  opacity: 0.1,
});

interface WelcomeScreenProps {
  onCreateNew: () => void;
  onImport: () => void;
  onAccessKeyContinue: (mnemonic: string) => void;
}

// The exported wallet artwork uses dark grays that flatten against the
// dark card surface; the brightness filter lifts the body just enough
// to keep the layered shadows and dashed cutouts legible.
const WalletHero: React.FC = () => (
  <WalletWelcomeLogo
    aria-hidden="true"
    className={cn(
      "block h-[92px] w-[120px] shrink-0",
      "dark:[filter:brightness(1.55)_contrast(0.92)]",
    )}
  />
);

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onCreateNew,
  onImport,
  onAccessKeyContinue,
}) => {
  const { validateMnemonic } = useLocalWallet();
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (error) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mnemonic]);

  const handleContinue = async () => {
    const trimmed = mnemonic.trim();
    if (!trimmed) {
      setError("Enter your access key to continue");
      return;
    }
    setVerifying(true);
    try {
      const ok = await validateMnemonic(trimmed);
      if (!ok) {
        setError("Invalid recovery phrase. Check the words and order.");
        return;
      }
      onAccessKeyContinue(trimmed);
    } finally {
      setVerifying(false);
    }
  };

  const canContinue = mnemonic.trim().length > 0 && !verifying;

  return (
    <div className="flex flex-1 w-full items-center justify-center px-4 py-6 overflow-hidden">
      <div className="relative">
        {/* Texture tiles are sized to the viewport, not the card, so
            wide displays don't end up with blank quadrants. */}
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
          // The default blue accent ring is suppressed for this card; the
          // Help & Support gate keeps it, the wallet welcome doesn't.
          borderClassName="bg-transparent dark:bg-transparent p-0 sm:p-0"
          contentClassName="flex justify-center"
          shellClassName={cn(
            "w-full min-w-0 max-w-[494px]",
            "bg-white dark:bg-[#1a1a1a]",
            // Solid 1px outline expressed as a box-shadow so it lays
            // on top of the inner card's drop-shadow halo and doesn't
            // get visually washed out. Matches the Figma spec
            // 1px solid #E3E3E3 / #313131 in dark.
            "shadow-[0_0_0_1px_#E3E3E3] dark:shadow-[0_0_0_1px_#313131]",
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
            <WalletHero />

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-[24px] font-medium leading-[32px] text-grey-10 dark:text-grey-light-100">
                Welcome to Hippius Wallet
              </h1>
              <p className="max-w-[424px] text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-50 dark:text-grey-dark-500">
                Enter your wallet mnemonic to continue or create a new wallet
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5">
              <label
                htmlFor="wallet-access-key"
                className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600"
              >
                Access Key
              </label>
              {/* Adornment slot keeps the shell's min-h-[54px] geometry —
                  an absolute icon + pl-* would inflate total height. */}
              <Input
                id="wallet-access-key"
                type="password"
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="Enter Access Key"
                autoComplete="off"
                disabled={verifying}
                startAdornment={<Key className="size-5 sm:size-6" />}
                aria-invalid={!!error}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleContinue();
                  }
                }}
              />
              {error ? (
                <p className="text-[12px] font-medium text-error-70">{error}</p>
              ) : null}
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
              {verifying ? "Verifying..." : "Continue"}
              {!verifying ? <ArrowRight className="size-4 shrink-0" /> : null}
            </Button>
          </div>

          <div className="flex flex-col gap-2 text-center">
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                Don&apos;t have a wallet?
              </span>
              <button
                type="button"
                onClick={onCreateNew}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark hover:underline underline-offset-2 transition-colors"
              >
                Create New Wallet
              </button>
            </p>
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                Have an existing wallet?
              </span>
              <button
                type="button"
                onClick={onImport}
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

export default WelcomeScreen;

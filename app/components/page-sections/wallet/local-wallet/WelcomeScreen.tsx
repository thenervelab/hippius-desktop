"use client";

import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { HippiusLogo, Key } from "@/components/ui/icons";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

/* Wallet onboarding welcome screen.
 *
 * Visual recipe matches the Help & Support page's access-key login
 * gate so the two onboarding surfaces feel like siblings:
 *
 *   1. Full-screen diagonal-stripe corner tiles sized to the viewport
 *      so the texture reaches every edge regardless of card width.
 *   2. Project's BackgroundContainer for the inner chrome — gray outer
 *      ring, framed inner stripe pattern, four corner-bracket
 *      "hippo logos", and a white content card. The default blue
 *      accent ring is suppressed via borderClassName="bg-transparent"
 *      per the wallet design (Help & Support keeps it).
 *
 * Three onboarding entry paths render inside the card body: inline
 * Access Key + Continue (paste a mnemonic and skip the dedicated import
 * screen), "Create New Wallet" link, and "Import Your Wallet" link.
 * The orchestrator (LocalWalletSetup) wires the callbacks. */

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

/* Small wallet-with-card illustration used as the card hero. Built
 * inline as nested rounded rects + HippiusLogo so the page ships
 * without a new PNG/SVG asset. Drop-in replacement once Figma exports
 * the final artwork. */
const WalletIllustration: React.FC = () => (
  <div className="relative mx-auto mb-5 h-[88px] w-[112px]">
    {/* Card peeking out behind the wallet */}
    <div className="absolute inset-x-3 top-0 h-[34px] rounded-[6px] bg-primary-50 shadow-[0px_2px_6px_rgba(49,103,221,0.35)]" />
    {/* Wallet body */}
    <div className="absolute inset-x-0 bottom-0 h-[64px] rounded-[10px] bg-[#0a0a0a] dark:bg-[#202020] shadow-[0px_4px_12px_rgba(0,0,0,0.18)]">
      {/* Card slot detail */}
      <div className="absolute left-3 right-3 top-2 h-[4px] rounded-full bg-[#2a2a2a]" />
      {/* Centered logo badge */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex size-[34px] items-center justify-center rounded-[6px] bg-primary-50">
          <HippiusLogo className="size-[18px] text-white [&_path]:[stroke:none]" />
        </div>
      </div>
    </div>
  </div>
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
        {/* Full-screen diagonal-stripe corner tiles — same recipe as
            the support page's AccessKeyLoginGate. The w-screen
            sizing makes the texture cover the visible area
            regardless of card dimensions. */}
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
          // Figma form/input is 462px wide; the inner card adds 16px
          // padding each side, so the outer max needs to be ~494px.
          className="relative w-full max-w-[494px]"
          fillClassName="fill-[#f9f9f9] dark:fill-[#202020]"
          strokeClassName="stroke-[#b3b3b3] dark:stroke-[#6c6c6c]"
          // Suppress the default blue accent ring per the Figma — the
          // outer gray ring and the white card stay; the inner colored
          // border just disappears.
          borderClassName="bg-transparent dark:bg-transparent p-0 sm:p-0"
          contentClassName="flex justify-center"
          shellClassName="w-full min-w-0 max-w-[494px]"
          // 16px card padding matches Figma's inner Container p-[16px];
          // 26px row gap matches the gap between the title-block and
          // the form-block in the Figma node.
          cardClassName="w-full min-w-0 max-w-full p-4 gap-[26px] items-stretch"
        >
          <div className="flex flex-col items-center gap-[19px]">
            <WalletIllustration />

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-[24px] font-medium leading-[32px] text-grey-10 dark:text-grey-light-100">
                Welcome to Hippius Wallet
              </h1>
              <p className="max-w-[424px] text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-[#4f4f4f] dark:text-grey-dark-600">
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
              {/* Use the project's Input adornment slot rather than an
                  absolute icon — keeps the shell's min-h-[54px] + p-4
                  geometry exactly matching the Figma input (462×54). */}
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
              <span className="font-medium text-[#4f4f4f] dark:text-grey-dark-500">
                Don&apos;t have a wallet?
              </span>
              <button
                type="button"
                onClick={onCreateNew}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark transition-colors"
              >
                Create New Wallet
              </button>
            </p>
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-[#4f4f4f] dark:text-grey-dark-500">
                Have an existing wallet?
              </span>
              <button
                type="button"
                onClick={onImport}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark transition-colors"
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

"use client";

import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { HippiusLogo, Key } from "@/components/ui/icons";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

/* Wallet onboarding welcome screen.
 *
 * Matches the Figma: a centered card on a diagonal-stripe textured
 * surface (same texture as the Help & Support access-key login gate).
 * Three entry paths:
 *   1. Inline "Access Key" input — paste an existing mnemonic and hit
 *      Continue to skip the dedicated import screen.
 *   2. "Create New Wallet" footer link — generate a fresh mnemonic.
 *   3. "Import Your Wallet" footer link — open the guided import
 *      textarea (kept around for users who prefer that flow).
 *
 * The diagonal-texture tiles use w-screen sizing so the backdrop
 * reaches every viewport edge regardless of the centered card's
 * dimensions — same pattern shipped on the support page. */

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
  /** Called with a validated mnemonic from the inline Access Key
   * input. The orchestrator hands it to the password step. */
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

  // Clear the error as soon as the user resumes typing — they're
  // self-correcting whatever was wrong with the last submission.
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
        {/* Diagonal-texture backdrop tiles, light + dark. Same recipe
            as the support page's AccessKeyLoginGate. */}
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

        {/* Card */}
        <div
          className={cn(
            "relative w-full max-w-[460px] rounded-[16px] p-6 sm:p-8",
            "bg-white dark:bg-[#1a1a1a]",
            "border border-grey-dark-100 dark:border-[#313131]",
            "shadow-[0px_14px_31px_0px_rgba(0,0,0,0.06),0px_56px_56px_0px_rgba(0,0,0,0.05)] dark:shadow-[0px_14px_31px_0px_rgba(0,0,0,0.4)]",
          )}
        >
          <WalletIllustration />

          <h1 className="text-center text-[24px] font-semibold leading-[32px] text-grey-10 dark:text-grey-light-100">
            Welcome to Hippius Wallet
          </h1>
          <p className="mt-2 text-center text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-grey-60 dark:text-grey-dark-600">
            Enter your wallet mnemonic to continue or create a new wallet
          </p>

          <div className="mt-6 space-y-2">
            <label
              htmlFor="wallet-access-key"
              className="block text-[13px] font-medium text-grey-70 dark:text-grey-dark-800"
            >
              Access Key
            </label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-grey-60 dark:text-grey-dark-600 pointer-events-none" />
              <Input
                id="wallet-access-key"
                type="password"
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="Enter Access Key"
                autoComplete="off"
                disabled={verifying}
                className={cn(
                  "h-12 pl-10 text-base font-medium",
                  error && "border-error-50",
                )}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleContinue();
                  }
                }}
              />
            </div>
            {error ? (
              <p className="text-[12px] font-medium text-error-70">{error}</p>
            ) : null}
          </div>

          <Button
            type="button"
            variant="primary"
            size="auto"
            className={cn(
              "mt-4 h-12 w-full rounded-[8px] text-[15px] font-medium tracking-[-0.3px] gap-2",
              // Lavender disabled state matching the Figma "inactive
              // Continue" treatment — fades the brand blue with white.
              !canContinue && "!bg-primary-50/40 hover:!bg-primary-50/40",
            )}
            onClick={handleContinue}
            disabled={!canContinue}
          >
            {verifying ? "Verifying..." : "Continue"}
            {!verifying ? <ArrowRight className="size-4 shrink-0" /> : null}
          </Button>

          <div className="mt-5 space-y-1.5 text-center">
            <p className="text-[13px] font-medium text-grey-60 dark:text-grey-dark-600">
              Don&apos;t have a wallet?{" "}
              <button
                type="button"
                onClick={onCreateNew}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark transition-colors"
              >
                Create New Wallet
              </button>
            </p>
            <p className="text-[13px] font-medium text-grey-60 dark:text-grey-dark-600">
              Have an existing wallet?{" "}
              <button
                type="button"
                onClick={onImport}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark transition-colors"
              >
                Import Your Wallet
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;

"use client";

import React, { useMemo, useState } from "react";
import { ArrowRight, Eye, EyeOff, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { Decoration, Key, WalletAsterisk } from "@/components/ui/icons";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

const cornerTextureLight = getDiagonalTextureSvgBackgroundImage({
  opacity: 0.21,
});
const cornerTextureDark = getDiagonalTextureSvgBackgroundImage({
  color: "white",
  opacity: 0.1,
});

const MIN_LEN = 8;

// Each rule's `test` runs against the entered password; failures are
// surfaced inline as a single "Password must contain X, Y, Z" message
// so the user sees exactly what's missing without a list of red dots.
const PASSWORD_RULES = [
  { label: "a lowercase letter", test: (p: string) => /[a-z]/.test(p) },
  { label: "an uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
  { label: "a number", test: (p: string) => /\d/.test(p) },
  { label: "a special character", test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

function describePasswordIssue(password: string, confirm: string): string | null {
  if (!password && !confirm) return null;
  if (password.length < MIN_LEN) {
    return `Password must be at least ${MIN_LEN} characters`;
  }
  const missing = PASSWORD_RULES.filter((r) => !r.test(password)).map(
    (r) => r.label,
  );
  if (missing.length > 0) {
    return `Password must contain ${missing.join(", ")}`;
  }
  if (confirm && password !== confirm) return "Passwords don't match";
  return null;
}

function isPasswordStrong(password: string): boolean {
  return (
    password.length >= MIN_LEN && PASSWORD_RULES.every((r) => r.test(password))
  );
}

// `create` is the default reached from "Create New Wallet" (step 2 of
// the new-wallet flow). `access` is reached from the welcome screen
// after the user pastes an existing access key — same underlying form,
// different hero / heading / footer wording so it reads as "logging in"
// rather than "creating".
export type CreatePasswordVariant = "create" | "access";

interface CreatePasswordScreenProps {
  mnemonic: string;
  initialName?: string;
  variant?: CreatePasswordVariant;
  onCreated: () => void;
  onBack: () => void;
}

const CreatePasswordScreen: React.FC<CreatePasswordScreenProps> = ({
  mnemonic,
  initialName,
  variant = "create",
  onCreated,
  onBack,
}) => {
  const { createWallet, setSetupStep } = useLocalWallet();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Wallet name is captured on the previous step (create-mnemonic). The
  // welcome→create-password shortcut (existing access key) doesn't set
  // one, so we fall back to a sensible default instead of forcing the
  // user back to pick one.
  const name = (initialName ?? "Main Wallet").trim() || "Main Wallet";

  // Inline validation message — recomputed as the user types so the
  // red-border state and the explanation appear together. Held back
  // until either field has any content so the form doesn't shout at
  // the user before they've started.
  const validationError = useMemo(
    () => describePasswordIssue(password, confirm),
    [password, confirm],
  );

  const canSubmit =
    !submitting && isPasswordStrong(password) && password === confirm;

  // What the inline error row renders: prefer the IPC failure (carries
  // server-side context) when present, otherwise the live validation
  // message. Empty fields → empty row.
  const displayError = error ?? validationError;

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(validationError ?? "Enter your password to continue");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ok = await createWallet(name, mnemonic, password);
      if (ok) {
        toast.success("Wallet created");
        onCreated();
      } else {
        setError("Failed to create wallet. Please try again.");
      }
    } catch (e) {
      console.error("Failed to create wallet:", e);
      setError(e instanceof Error ? e.message : "Failed to create wallet");
    } finally {
      setSubmitting(false);
    }
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
            {variant === "access" ? (
              <div className="flex items-center justify-center gap-2 shrink-0">
                <WalletAsterisk
                  aria-hidden="true"
                  className="size-[88px]"
                />
                <WalletAsterisk
                  aria-hidden="true"
                  className="size-[88px]"
                />
                <WalletAsterisk
                  aria-hidden="true"
                  className="size-[88px]"
                />
              </div>
            ) : (
              <div className="relative flex items-center justify-center size-[56px] shrink-0">
                <Decoration
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 size-full"
                />
                <div className="relative flex items-center justify-center size-[32px] aspect-square rounded-[8px] bg-primary-50 dark:bg-primary-brand-dark">
                  <Plus
                    className="size-4 shrink-0 text-white"
                    strokeWidth={2.5}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-[24px] font-medium leading-[32px] text-grey-10 dark:text-grey-light-100">
                {variant === "access" ? "Enter Your Passcode" : "Create New Wallet"}
              </h1>
              <p className="max-w-[424px] text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-50 dark:text-grey-dark-500">
                {variant === "access"
                  ? "Enter your account passcode to confirm and get started"
                  : "Enter your access key to continue or create a new wallet"}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5">
              <label
                htmlFor="wallet-passcode"
                className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600"
              >
                Passcode
              </label>
              <Input
                id="wallet-passcode"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                type={showPassword ? "text" : "password"}
                placeholder="Enter your passcode"
                autoComplete="new-password"
                aria-invalid={!!password && !isPasswordStrong(password)}
                startAdornment={<Key className="size-5 sm:size-6" />}
                endAdornment={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="text-grey-50 dark:text-grey-dark-600 hover:text-grey-10 dark:hover:text-grey-light-100"
                    aria-label={
                      showPassword ? "Hide passcode" : "Show passcode"
                    }
                  >
                    {showPassword ? (
                      <EyeOff className="size-5" />
                    ) : (
                      <Eye className="size-5" />
                    )}
                  </button>
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
            </div>

            <div className="flex flex-col gap-2.5">
              <label
                htmlFor="wallet-passcode-confirm"
                className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600"
              >
                Confirm Passcode
              </label>
              <Input
                id="wallet-passcode-confirm"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setError(null);
                }}
                type={showConfirm ? "text" : "password"}
                placeholder="Confirm your passcode"
                autoComplete="new-password"
                aria-invalid={!!confirm && confirm !== password}
                startAdornment={<Key className="size-5 sm:size-6" />}
                endAdornment={
                  <button
                    type="button"
                    onClick={() => setShowConfirm((s) => !s)}
                    className="text-grey-50 dark:text-grey-dark-600 hover:text-grey-10 dark:hover:text-grey-light-100"
                    aria-label={showConfirm ? "Hide passcode" : "Show passcode"}
                  >
                    {showConfirm ? (
                      <EyeOff className="size-5" />
                    ) : (
                      <Eye className="size-5" />
                    )}
                  </button>
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
            </div>

            {displayError ? (
              <p className="text-[12px] font-medium text-error-70">
                {displayError}
              </p>
            ) : null}

            <Button
              type="button"
              variant="primary"
              size="auto"
              className={cn(
                "h-[52px] w-full rounded-[6px] gap-2.5 px-2.5",
                "text-[18px] font-normal tracking-[-0.36px] leading-[1.109]",
                !canSubmit && "!bg-primary-50/40 hover:!bg-primary-50/40",
              )}
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting
                ? variant === "access"
                  ? "Continuing..."
                  : "Creating..."
                : variant === "access"
                  ? "Continue"
                  : "Create Wallet"}
              {!submitting ? <ArrowRight className="size-4 shrink-0" /> : null}
            </Button>
          </div>

          <div className="flex flex-col gap-2 text-center">
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                {variant === "access"
                  ? "Don't have a wallet?"
                  : "Already have a wallet?"}
              </span>
              <button
                type="button"
                onClick={
                  variant === "access"
                    ? () => setSetupStep("create-mnemonic")
                    : onBack
                }
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark hover:underline underline-offset-2 transition-colors"
              >
                {variant === "access" ? "Create New Wallet" : "Access Wallet"}
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

export default CreatePasswordScreen;

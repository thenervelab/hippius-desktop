/**
 * Access Key Login Form Component
 *
 * Simplified login flow - only takes the access key (mnemonic) and logs user in.
 * No passcode screen or wallet creation steps.
 */

"use client";

import React, { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Input from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ArrowRight2, Key } from "@/components/ui/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { BackButton } from "@/components/ui";
import ButtonCard from "../ui/button/CardButton";

interface AccessKeyLoginFormProps {
  onBack: () => void;
}

export function AccessKeyLoginForm({ onBack }: AccessKeyLoginFormProps) {
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logginIn, setLoggingIn] = useState(false);
  const [version, setVersion] = useState<string>("");

  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useWalletAuth();

  useEffect(() => {
    getVersion().then((v) => setVersion(v));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mnemonic.trim()) {
      setError("Please enter your access key");
      return;
    }

    setError(null);
    setLoggingIn(true);

    try {
      // login() returns the substrate address directly — no localStorage parsing needed.
      // The welcome notification is now created by Rust in
      // login_with_mnemonic::ensure_welcome_notification, user-scoped
      // dedup makes it a no-op on repeat logins.
      await login(mnemonic.trim());

      const redirectPath = searchParams.get("redirect") || "/";
      router.replace(redirectPath);
    } catch (error) {
      console.error("Failed to login with access key:", error);
      setError(
        error instanceof Error
          ? error.message
          : "Invalid access key. Please ensure you've entered a valid 12-word mnemonic phrase."
      );
      setLoggingIn(false);
    }
  };

  return (
    <div className="opacity-0 animate-fade-in-0.5 w-full">
      <div className="space-y-[min(1rem,16px)] text-grey-10 w-full">
        {/* Back Button */}
        <BackButton onBack={onBack} text="Back" />

        <form onSubmit={handleLogin} className="space-y-6">
          {/* Title */}
          <div>
            <h1 className="text-grey-10 text-[min(2rem,32px)] font-medium">
              Login with your access key
            </h1>
            <p className="text-[min(0.875rem,14px)] font-medium text-grey-70">
              Please enter your access key to confirm and start creating your
              account
            </p>
          </div>

          {/* Access Key Input */}
          <div className="space-y-2">
            <Label
              htmlFor="accessKey"
              className="text-sm font-medium text-grey-70"
            >
              Access Key
            </Label>

            <div className="relative">
              <Key className="size-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-grey-60" />
              <Input
                id="accessKey"
                placeholder="Enter your access key"
                type="password"
                value={mnemonic}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setMnemonic(e.target.value)
                }
                className="pl-10 pr-4 border-grey-80 h-14 text-grey-10 bg-grey-100 font-normal text-[0.9375rem] rounded-lg duration-200 outline-none hover:border-grey-70 placeholder-grey-60 focus:ring-0 focus:border-primary-50 w-full"
                disabled={logginIn}
              />
            </div>
          </div>

          {error && (
            <div className="flex text-error-70 text-sm font-medium items-center gap-2">
              <AlertCircle className="size-4" />
              <span>{error}</span>
            </div>
          )}

          {/* Primary Button */}
          <ButtonCard
            type="submit"
            className={cn(
              "w-full flex h-12 text-white font-semibold text-base rounded",
              "bg-primary-50 hover:bg-primary-60 transition-colors"
            )}
            disabled={logginIn}
            icon={
              logginIn ? (
                <Loader2 className="size-4 animate-spin text-white" />
              ) : (
                <ArrowRight2 className="size-4" />
              )
            }
          >
            {logginIn ? "Logging in..." : "Log In"}
          </ButtonCard>
        </form>
      </div>
      {/* Footer Links */}
      <div className="space-y-[min(0.5rem,8px)] mt-[min(0.5rem,8px)]">
        <div className="text-center">
          <p className="text-[min(0.75rem,12px)] text-grey-60 font-semibold">
            By continuing, you agree to our{" "}
            <button
              type="button"
              onClick={() =>
                openUrl("https://hippius.com/terms-and-conditions")
              }
              className="text-primary-50 font-semibold hover:text-primary-60 transition-colors cursor-pointer"
            >
              Terms and Conditions
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => openUrl("https://hippius.com/privacy-policy")}
              className="text-primary-50 font-semibold hover:text-primary-60 transition-colors cursor-pointer"
            >
              Privacy Policy
            </button>
          </p>
        </div>

        <div className="text-center text-[min(0.75rem,12px)] text-grey-70 font-medium">
          <p>Version {version}</p>
        </div>
      </div>
    </div>
  );
}

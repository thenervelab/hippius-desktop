/**
 * Access Key Login Form Component
 *
 * Simplified login flow - only takes the access key (mnemonic) and logs user in.
 * No passcode screen or wallet creation steps.
 */

"use client";

import React, { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2 } from "lucide-react";
import { ArrowRight, Eye, EyeOff, Key } from "@/components/ui/icons";
import { LogoMark } from "@/components/ui/LogoMark";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/button";

interface AccessKeyLoginFormProps {
  onBack: () => void;
}

export function AccessKeyLoginForm({ onBack }: AccessKeyLoginFormProps) {
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logginIn, setLoggingIn] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [showSecret, setShowSecret] = useState(false);

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
          : "Invalid access key. Please ensure you've entered a valid 12-word mnemonic phrase.",
      );
      setLoggingIn(false);
    }
  };

  return (
    <div className="opacity-0 animate-fade-in-0.5 w-full flex justify-center">
      <div
        className="w-full max-w-[495px] bg-[#fffdff]  dark:bg-[#161416] rounded-[8px] p-[min(1rem,16px)] flex flex-col gap-[min(1.625rem,26px)] items-center overflow-hidden"
        style={{
          boxShadow:
            "0px 14px 31px 0px rgba(0,0,0,0.06), 0px 56px 56px 0px rgba(0,0,0,0.05), 0px 126px 76px 0px rgba(0,0,0,0.03), 0px 224px 90px 0px rgba(0,0,0,0.01)",
        }}
      >
        <div className="flex flex-col gap-[min(0.75rem,12px)] items-center w-full">
          <LogoMark />
          <h1 className="w-full text-center text-grey-10 dark:text-grey-light-100 font-medium text-[min(1.5rem,24px)] leading-[min(2rem,32px)]">
            Log In to Hippius
          </h1>
        </div>

        <div className="flex flex-col gap-[min(1rem,16px)] items-center w-full">
          <form
            onSubmit={handleLogin}
            className="flex flex-col gap-[min(1rem,16px)] items-center w-full"
          >
            <div className="flex flex-col gap-[min(0.5rem,8px)] items-start w-full">
              <p className="font-medium text-[min(1.125rem,18px)] leading-[min(1.5rem,24px)] tracking-[-0.02em] text-grey-10 dark:text-grey-light-100">
                Enter Your Access Key To Continue
              </p>

              <div className="flex flex-col gap-[min(0.625rem,10px)] items-start w-full">
                <div className="flex gap-[min(0.5rem,8px)] items-center">
                  <label
                    htmlFor="accessKey"
                    className="font-medium text-[min(0.875rem,14px)] leading-[min(1.25rem,20px)] tracking-[-0.02em] text-grey-dark-600"
                  >
                    Access Key
                  </label>
                </div>

                <Input
                  id="accessKey"
                  placeholder="Enter or paste seed words here"
                  type={showSecret ? "text" : "password"}
                  value={mnemonic}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setMnemonic(e.target.value)
                  }
                  disabled={logginIn}
                  aria-invalid={Boolean(error)}
                  startAdornment={<Key className="size-[min(1.5rem,24px)]" />}
                  endAdornment={
                    <button
                      type="button"
                      onClick={() => setShowSecret((s) => !s)}
                      className="text-grey-dark-800 hover:text-grey-10 dark:hover:text-grey-light-100 transition-colors cursor-pointer"
                      aria-label={
                        showSecret ? "Hide access key" : "Show access key"
                      }
                    >
                      {showSecret ? (
                        <EyeOff className="size-[min(1.5rem,24px)]" />
                      ) : (
                        <Eye className="size-[min(1.5rem,24px)]" />
                      )}
                    </button>
                  }
                />
              </div>
            </div>

            {error && (
              <p
                className="w-full text-error-70 text-[min(0.875rem,14px)] leading-[min(1.25rem,20px)] tracking-[-0.02em] font-medium"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              size="auto"
              dotSize={4}
              disabled={logginIn}
              className="w-full h-[min(3.25rem,52px)] gap-[min(0.625rem,10px)] px-[min(0.625rem,10px)] py-[min(0.625rem,10px)] text-[min(1.125rem,18px)] tracking-[-0.02em] font-normal text-white leading-[1.109]"
            >
              {logginIn ? (
                <Loader2 className="size-4 animate-spin text-white" />
              ) : (
                <>
                  <span>Log In</span>
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>

            <Button
              type="button"
              variant="defaultStable"
              size="auto"
              dotSize={4}
              onClick={onBack}
              disabled={logginIn}
              className="w-full h-[min(3.25rem,52px)] gap-[min(0.625rem,10px)] px-[min(0.625rem,10px)] py-[min(0.625rem,10px)] text-[min(1.125rem,18px)] tracking-[-0.02em] font-normal text-grey-10 dark:text-grey-light-100 leading-[1.109] border border-grey-80 dark:border-[#494949] bg-white dark:bg-[#2c2c2c] hover:bg-grey-90 dark:hover:bg-[#2e2e2e]"
            >
              <span>Choose another log in method</span>
              <ArrowRight className="size-4" />
            </Button>
          </form>

          <p className="w-full text-center text-[min(0.75rem,12px)] leading-[min(1.125rem,18px)] tracking-[-0.02em] text-grey-dark-800 font-medium">
            By continuing you agree to our{" "}
            <button
              type="button"
              onClick={() =>
                openUrl("https://hippius.com/terms-and-conditions")
              }
              className="font-semibold text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
            >
              Terms and Conditions
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => openUrl("https://hippius.com/privacy-policy")}
              className="font-semibold text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
            >
              Privacy Policy
            </button>
          </p>

          <p className="text-[min(0.75rem,12px)] leading-[min(1.125rem,18px)] tracking-[-0.02em] text-grey-dark-600 font-medium">
            Version {version}
          </p>
        </div>
      </div>
    </div>
  );
}

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
import {
  addNotification,
} from "@/app/lib/helpers/notificationsDb";

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
      await login(mnemonic.trim());

      // Get the user address from session after login
      await new Promise(resolve => setTimeout(resolve, 100));
      const storedSession = localStorage.getItem("hippius_oauth_session");
      let userAddress: string | null = null;

      if (storedSession) {
        try {
          const session = JSON.parse(storedSession);
          userAddress = session.substrateAddress;
        } catch (e) {
          console.error("[AccessKeyLogin] Failed to parse session:", e);
        }
      }

      // Add welcome notification if we have the address
      if (userAddress) {
        console.log("[AccessKeyLogin] Creating welcome notification for:", userAddress);
        await addNotification({
          userAddress,
          notificationType: "Hippius",
          notificationSubtype: "Welcome",
          notificationTitleText: "Hello from Hippius 👋  Here's what's new!",
          notificationDescription: `🎉 Welcome to Hippius! You're now part of a decentralised storage network. To get started, open the Files tab and upload your data. Each upload uses credits from your balance. We keep credit pricing simple and fair, so you always know what you're spending. You can check your remaining credits at any time in the billing tab, and top up when you need more. When you're ready, tap Check Out to launch your first storage session.`,
          notificationLinkText: "Check Out",
          notificationLink: "/files",
        });
      }

      // Get redirect parameter from URL or default to dashboard
      const redirectPath = searchParams.get("redirect") || "/";
      console.log("[AccessKeyLogin] Redirecting to:", redirectPath);

      // Use replace to avoid adding to history and prevent back button issues
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
      <div className="space-y-4 text-grey-10 w-full">
        {/* Back Button */}
        <BackButton onBack={onBack} text="Back" />

        <form onSubmit={handleLogin} className="space-y-6">
          {/* Title */}
          <div>
            <h1 className="text-grey-10 text-[32px] font-medium">
              Login with your access key
            </h1>
            <p className="text-sm font-medium text-grey-70">
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
                className="pl-10 pr-4 border-grey-80 h-14 text-grey-10 bg-grey-100 font-normal text-[15px] rounded-lg duration-200 outline-none hover:border-grey-70 placeholder-grey-60 focus:ring-0 focus:border-primary-50 w-full"
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
      <div className="space-y-2 mt-2">
        <div className="text-center">
          <p className="text-xs text-grey-60 font-semibold">
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

        <div className="text-center text-xs text-grey-70 font-medium">
          <p>Version {version}</p>
        </div>
      </div>
    </div>
  );
}

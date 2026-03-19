"use client";

import React, { useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Key } from "@/components/ui/icons";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import SectionHeader from "./SectionHeader";
import { RevealTextLine } from "@/components/ui";
import { InView } from "react-intersection-observer";
import { Code } from "lucide-react";

const API_TOKEN_DOCS_URL =
  "https://docs.hippius.com/use/desktop/settings#api-token";

function useMaskToken() {
  return (token: string) => {
    if (!token) return "";
    const visibleStart = token.slice(0, 8);
    const visibleEnd = token.slice(-8);
    const maskedMiddle = "•".repeat(Math.min(token.length - 16, 40));
    return `${visibleStart}${maskedMiddle}${visibleEnd}`;
  };
}

/**
 * Card 1: API Token display with copy/reveal.
 */
export const ApiTokenCard: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const token = oauthSession?.token || "";

  const [copiedToken, setCopiedToken] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const maskToken = useMaskToken();

  const copyTokenToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
      toast.success("Token copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
      toast.error("Failed to copy token");
    }
  };

  if (!token) {
    return (
      <SectionHeader
        Icon={Key}
        title="API Token"
        subtitle="No authentication token available. Please log in to view your API token."
      />
    );
  }

  return (
    <div className="flex flex-col w-full">
      <SectionHeader
        Icon={Key}
        title="API Token"
        subtitle="Your authentication token for API access"
        info="Your API token allows you to authenticate requests to the Hippius platform. Keep it secure and never share it with anyone."
        learnMoreUrl={API_TOKEN_DOCS_URL}
      />

      {/* Token Display */}
      <div className="space-y-1 w-full mt-4">
        <h3 className="text-sm font-medium text-grey-70">Token</h3>
        <div className="border border-grey-80 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-base bg-white">
          <div className="flex items-center justify-between gap-2">
            <div className="text-grey-60 font-medium break-all flex-1">
              {showToken ? token : maskToken(token)}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setShowToken(!showToken)}
                className="rounded transition text-grey-60 hover:text-grey-70"
                title={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff className="size-6" /> : <Eye className="size-6" />}
              </button>
              <button
                onClick={copyTokenToClipboard}
                className={cn(
                  "rounded transition",
                  copiedToken ? "text-success-50" : "text-grey-60 hover:text-grey-70"
                )}
                title="Copy token"
              >
                {copiedToken ? <Check className="size-5" /> : <Copy className="size-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Card 2: API Token usage example with authorization header.
 */
export const ApiTokenUsageCard: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const token = oauthSession?.token || "";

  const [copiedHeader, setCopiedHeader] = useState(false);
  const [showHeaderToken, setShowHeaderToken] = useState(false);
  const maskToken = useMaskToken();

  const copyHeaderToClipboard = async () => {
    try {
      const headerText = `Authorization: Token ${token}`;
      await navigator.clipboard.writeText(headerText);
      setCopiedHeader(true);
      setTimeout(() => setCopiedHeader(false), 2000);
      toast.success("Authorization header copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
      toast.error("Failed to copy header");
    }
  };

  if (!token) return null;

  return (
    <div className="flex flex-col w-full">
      <SectionHeader
        Icon={Code}
        title="API Token Usage Example"
        subtitle="Use this token to authenticate API requests to the Hippius platform"
      />

      {/* Authorization Header */}
      <div className="space-y-1 w-full mt-4">
        <h3 className="text-sm font-medium text-grey-70">Authorization Header</h3>
        <div className="border border-grey-80 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-base bg-white">
          <div className="flex items-center justify-between gap-2">
            <div className="text-base text-grey-60 font-medium break-all flex-1">
              Authorization: Token {showHeaderToken ? token : maskToken(token)}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setShowHeaderToken(!showHeaderToken)}
                className="rounded transition text-grey-60 hover:text-grey-70"
                title={showHeaderToken ? "Hide token" : "Show token"}
              >
                {showHeaderToken ? <EyeOff className="size-6" /> : <Eye className="size-6" />}
              </button>
              <button
                onClick={copyHeaderToClipboard}
                className={cn(
                  "rounded transition",
                  copiedHeader ? "text-success-50" : "text-grey-60 hover:text-grey-70"
                )}
                title="Copy authorization header"
              >
                {copiedHeader ? <Check className="size-5" /> : <Copy className="size-5" />}
              </button>
            </div>
          </div>
        </div>
        <p className="text-xs text-grey-60">
          Include this header in your API requests to access storage control,
          file upload, and other authenticated endpoints.
        </p>
      </div>

      {/* Security Warning */}
      <div className="bg-warning-90/20 border border-warning-80 rounded-lg p-3 mt-4">
        <div className="flex gap-2">
          <div className="mt-0.5">
            <div className="size-5 rounded-full bg-warning-50/20 flex items-center justify-center">
              <span className="text-warning-50 text-sm font-bold">!</span>
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-warning-10">
              Keep your API token secure
            </p>
            <p className="text-sm text-warning-30">
              Never share your API token with anyone. It provides full
              access to your account and should be treated like a password.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

// Keep default export for backward compatibility
const OAuthTokenSection: React.FC = () => (
  <div className="flex flex-col gap-6 w-full">
    <ApiTokenCard />
    <ApiTokenUsageCard />
  </div>
);

export default OAuthTokenSection;

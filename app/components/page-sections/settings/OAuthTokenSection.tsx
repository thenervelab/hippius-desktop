"use client";

import React, { useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { SettingsCard } from "./SettingsCard";
import { cn } from "@/lib/utils";

export const API_TOKEN_DOCS_URL =
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

// Shared row layout: token text on the left + eye / copy icons on the right.
function TokenRow({
  text,
  show,
  onToggleShow,
  copied,
  onCopy,
}: {
  text: string;
  show: boolean;
  onToggleShow: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="font-mono text-sm font-medium text-grey-10 dark:text-white break-all min-w-0 flex-1">
        {text}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide token" : "Show token"}
          className="text-grey-60 hover:text-grey-40 dark:text-grey-dark-500 dark:hover:text-white transition-colors"
        >
          {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy to clipboard"
          className={cn(
            "transition-colors",
            copied
              ? "text-success-50"
              : "text-grey-60 hover:text-grey-40 dark:text-grey-dark-500 dark:hover:text-white"
          )}
        >
          {copied ? <Check className="size-[18px]" /> : <Copy className="size-[18px]" />}
        </button>
      </div>
    </div>
  );
}

/**
 * Card 1: API Token display with copy/reveal.
 */
export const ApiTokenCard: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const token = oauthSession?.token || "";

  const [copied, setCopied] = useState(false);
  const [show, setShow] = useState(false);
  const maskToken = useMaskToken();

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Token copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
      toast.error("Failed to copy token");
    }
  };

  if (!token) {
    return (
      <SettingsCard label="API Token">
        <p className="px-4 py-4 text-sm text-grey-60 dark:text-grey-dark-500">
          No authentication token available. Please log in to view your API token.
        </p>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard label="API Token">
      <TokenRow
        text={show ? token : maskToken(token)}
        show={show}
        onToggleShow={() => setShow(!show)}
        copied={copied}
        onCopy={copyToClipboard}
      />
    </SettingsCard>
  );
};

/**
 * Card 2: API Token usage example with authorization header.
 */
export const ApiTokenUsageCard: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const token = oauthSession?.token || "";

  const [copied, setCopied] = useState(false);
  const [show, setShow] = useState(false);
  const maskToken = useMaskToken();

  const copyToClipboard = async () => {
    try {
      const headerText = `Authorization: Token ${token}`;
      await navigator.clipboard.writeText(headerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Authorization header copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
      toast.error("Failed to copy header");
    }
  };

  if (!token) return null;

  return (
    <div>
      <SettingsCard label="API Token Usage Example">
        <TokenRow
          text={`Authorization: Token ${show ? token : maskToken(token)}`}
          show={show}
          onToggleShow={() => setShow(!show)}
          copied={copied}
          onCopy={copyToClipboard}
        />
      </SettingsCard>
      <p className="mt-2 text-sm text-grey-60 dark:text-grey-dark-500">
        Include this header in your API requests to access storage control, file
        upload, and other authenticated endpoints.
      </p>
    </div>
  );
};

/**
 * Default export: both cards with shared entry animation, used by the
 * settings page when section === "api-keys".
 */
const OAuthTokenSection: React.FC = () => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex flex-col gap-4">
          <div
            className={cn(
              "transition-all duration-500 ease-out",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <ApiTokenCard />
          </div>
          <div
            className={cn(
              "transition-all duration-500 ease-out delay-150",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <ApiTokenUsageCard />
          </div>
        </div>
      )}
    </InView>
  );
};

export default OAuthTokenSection;

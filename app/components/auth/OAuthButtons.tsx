/**
 * OAuth Login Buttons
 *
 * Reusable button components for OAuth authentication with Google, Apple, and GitHub.
 * Follows DRY principle with a single reusable button component.
 */

"use client";

import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { OAuthProvider } from "@/app/lib/types/oAuth";
import { LucideLoader2 } from "lucide-react";
import * as Icons from "@/components/ui/icons";
import { Button } from "@/components/ui/button/ButtonV2";

interface OAuthButtonProps {
  provider: OAuthProvider;
  className?: string;
  disabled?: boolean;
}

const PROVIDER_CONFIG: Record<
  OAuthProvider,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
  }
> = {
  google: {
    icon: Icons.Google,
    label: "Continue with Google",
  },
  github: {
    icon: Icons.Github,
    label: "Continue with Github",
  },
  apple: {
    icon: Icons.Apple,
    label: "Continue with Apple",
  },
};

const AUTH_BUTTON_CLASSES = cn(
  "w-full h-[min(3.75rem,60px)] gap-[8px] px-[16px] py-[12px]",
  "text-[min(1.125rem,18px)] leading-[min(1.5rem,24px)] tracking-[-0.02em] font-medium",
);

function AuthButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  isLoading = false,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  className?: string;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoading}
      variant="default"
      size="auto"
      dotSize={6}
      className={cn(AUTH_BUTTON_CLASSES, className)}
    >
      {isLoading ? (
        <LucideLoader2 className="size-4 animate-spin" />
      ) : (
        <>
          <Icon className="size-4" />
          <span>{label}</span>
        </>
      )}
    </Button>
  );
}

export function OAuthButton({
  provider,
  className,
  disabled,
}: OAuthButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  React.useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setIsLoading(false);
      }
    };

    const handleFocus = () => {
      setIsLoading(false);
    };

    setIsLoading(false);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const handleClick = async () => {
    if (disabled) return;

    try {
      setIsLoading(true);

      const urlParams = new URLSearchParams(window.location.search);
      const redirectParam = urlParams.get("redirect");
      if (redirectParam) {
        sessionStorage.setItem("oauth_redirect", redirectParam);
      }

      const result = await invoke<{ url: string; provider: string }>(
        "start_oauth_flow",
        { provider },
      );
      await openUrl(result.url);
    } catch (error) {
      console.error(`Failed to initiate ${provider} login:`, error);
      setIsLoading(false);
    }
  };

  const config = PROVIDER_CONFIG[provider];

  return (
    <AuthButton
      icon={config.icon}
      label={config.label}
      onClick={handleClick}
      disabled={disabled}
      isLoading={isLoading}
      className={className}
    />
  );
}

export function AccessKeyButton({
  onClick,
  className,
  disabled = false,
}: {
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <AuthButton
      icon={Icons.Key}
      label="Continue with Access Key"
      onClick={onClick}
      disabled={disabled}
      className={className}
    />
  );
}

interface OAuthButtonsGroupProps {
  onAccessKeyClick: () => void;
  className?: string;
  disabled?: boolean;
  hideAccessKey?: boolean;
}

export function OAuthButtonsGroup({
  onAccessKeyClick,
  className,
  disabled,
  hideAccessKey = false,
}: OAuthButtonsGroupProps) {
  return (
    <div
      className={cn("flex flex-col gap-[min(0.5rem,8px)] w-full", className)}
    >
      <OAuthButton provider="google" disabled={disabled} />
      <OAuthButton provider="github" disabled={disabled} />
      {/* Apple login disabled - backend integration not ready */}
      <OAuthButton provider="apple" disabled={true} />

      {!hideAccessKey && (
        <AccessKeyButton onClick={onAccessKeyClick} disabled={disabled} />
      )}
    </div>
  );
}

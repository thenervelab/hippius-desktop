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

interface OAuthButtonProps {
    provider: OAuthProvider;
    className?: string;
    disabled?: boolean;
}

/**
 * Base button configuration for providers
 */
const PROVIDER_CONFIG: Record<OAuthProvider, {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
}> = {
    google: {
        icon: Icons.Google,
        label: "Continue with Google",
    },
    github: {
        icon: Icons.Github,
        label: "Continue with GitHub",
    },
    apple: {
        icon: Icons.Apple,
        label: "Continue with Apple",
    },
};

/**
 * Reusable Auth Button Component (DRY principle)
 */
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
        <button
            type="button"
            onClick={onClick}
            disabled={disabled || isLoading}
            className={cn(
                "w-full flex items-center justify-center gap-2 h-[3.75rem] font-semibold text-lg rounded-lg",
                "bg-grey-90 text-grey-10",
                "hover:bg-grey-80",
                "transition-all duration-200",
                "disabled:opacity-70 disabled:cursor-not-allowed",
                className
            )}
        >
            {isLoading ? (
                <LucideLoader2 className="size-4 animate-spin" />
            ) : (
                <>
                    <Icon className="size-4" />
                    <span>{label}</span>
                </>
            )}
        </button>
    );
}

/**
 * Individual OAuth Button Component
 */
export function OAuthButton({
    provider,
    className,
    disabled,
}: OAuthButtonProps) {
    const [isLoading, setIsLoading] = useState(false);

    // Reset loading state when user returns to page (handles cancelled OAuth flows)
    React.useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                setIsLoading(false);
            }
        };

        const handleFocus = () => {
            setIsLoading(false);
        };

        // Reset on component mount
        setIsLoading(false);

        // Reset when page becomes visible again
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleFocus);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleFocus);
        };
    }, []);

    const handleClick = async () => {
        if (disabled) return;

        try {
            setIsLoading(true);

            // Preserve redirect parameter if present
            const urlParams = new URLSearchParams(window.location.search);
            const redirectParam = urlParams.get("redirect");
            if (redirectParam) {
                sessionStorage.setItem("oauth_redirect", redirectParam);
            }

            const result = await invoke<{ url: string; provider: string }>(
                "start_oauth_flow",
                { provider }
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

/**
 * Access Key Button Component
 */
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

/**
 * OAuth Buttons Group Component
 * Displays all OAuth provider buttons with divider
 */
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
        <div className={cn("space-y-4", className)}>
            {/* Social OAuth Buttons */}
            <OAuthButton provider="google" disabled={disabled} />
            <OAuthButton provider="github" disabled={disabled} />
            {/* Apple login disabled - backend integration not ready */}
            <OAuthButton provider="apple" disabled={true} />

            {/* Access Key Button */}
            {!hideAccessKey && (
                <AccessKeyButton onClick={onAccessKeyClick} disabled={disabled} />
            )}
        </div>
    );
}

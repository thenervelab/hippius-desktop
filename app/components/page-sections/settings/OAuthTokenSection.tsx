"use client";

import React, { useState } from "react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Key } from "@/components/ui/icons";
import { useWalletAuth } from "@/lib/wallet-auth-context";

const OAuthTokenSection: React.FC = () => {
    const { oauthSession } = useWalletAuth();
    const token = oauthSession?.token || "";

    const [copiedToken, setCopiedToken] = useState(false);
    const [copiedHeader, setCopiedHeader] = useState(false);
    const [showToken, setShowToken] = useState(false);
    const [showHeaderToken, setShowHeaderToken] = useState(false);

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

    const maskToken = (token: string) => {
        if (!token) return "";
        const visibleStart = token.slice(0, 8);
        const visibleEnd = token.slice(-8);
        const maskedMiddle = "•".repeat(Math.min(token.length - 16, 40));
        return `${visibleStart}${maskedMiddle}${visibleEnd}`;
    };

    if (!token) {
        return (
            <div className="w-full space-y-6">
                <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center flex-wrap gap-2">
                    <div className="flex items-start gap-2">
                        <AbstractIconWrapper className="size-8 sm:size-10 bg-grey-10 relative">
                            <Key className="absolute size-5 sm:size-6 text-primary-50" />
                        </AbstractIconWrapper>
                        <div className="flex flex-col gap-2">
                            <h2 className="text-lg sm:text-[22px] font-medium">
                                Master Token
                            </h2>
                            <p className="text-base leading-[22px] text-grey-60 font-medium">
                                No authentication token available. Please log in to view your
                                master token.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center flex-wrap gap-2">
                <div className="flex items-start gap-2">
                    <AbstractIconWrapper className="size-8 sm:size-10 bg-grey-10 relative">
                        <Key className="absolute size-5 sm:size-6 text-primary-50" />
                    </AbstractIconWrapper>
                    <div className="flex flex-col gap-2">
                        <h2 className="text-lg sm:text-[22px] font-medium">Master Token</h2>
                        <p className="text-base leading-[22px] text-grey-60 font-medium ">
                            Your master authentication token for API access
                        </p>
                    </div>
                </div>
            </div>

            {/* Token Display */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-grey-70">Token</h3>
                <div className="text-sm text-grey-60">
                    <div className="border border-grey-80 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-base relative group">
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
                                    {showToken ? (
                                        <EyeOff className="size-6" />
                                    ) : (
                                        <Eye className="size-6" />
                                    )}
                                </button>
                                <button
                                    onClick={copyTokenToClipboard}
                                    className={cn(
                                        "rounded transition",
                                        copiedToken
                                            ? "text-success-50"
                                            : "text-grey-60 hover:text-grey-70"
                                    )}
                                    title="Copy token"
                                >
                                    {copiedToken ? (
                                        <Check className="size-5" />
                                    ) : (
                                        <Copy className="size-5" />
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Token Usage Section */}
            <div className="space-y-2">
                <h3 className="text-lg font-medium text-grey-10">Token Usage</h3>
                <p className="text-base text-grey-60 font-medium">
                    Use this token to authenticate API requests to the Hippius platform:
                </p>
                <h3 className="!mt-4 text-sm font-medium text-grey-70">Token</h3>
                <div className="text-sm text-grey-60">
                    <div className="border border-grey-80 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-base relative group">
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-base text-grey-60 font-medium break-all flex-1">
                                Authorization: Token{" "}
                                {showHeaderToken ? token : maskToken(token)}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                <button
                                    onClick={() => setShowHeaderToken(!showHeaderToken)}
                                    className="rounded transition text-grey-60 hover:text-grey-70"
                                    title={showHeaderToken ? "Hide token" : "Show token"}
                                >
                                    {showHeaderToken ? (
                                        <EyeOff className="size-6" />
                                    ) : (
                                        <Eye className="size-6" />
                                    )}
                                </button>
                                <button
                                    onClick={copyHeaderToClipboard}
                                    className={cn(
                                        "rounded transition",
                                        copiedHeader
                                            ? "text-success-50"
                                            : "text-grey-60 hover:text-grey-70"
                                    )}
                                    title="Copy authorization header"
                                >
                                    {copiedHeader ? (
                                        <Check className="size-5" />
                                    ) : (
                                        <Copy className="size-5" />
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <p className="text-xs">
                    Include this header in your API requests to access storage control,
                    file upload, and other authenticated endpoints.
                </p>
                <div className="bg-warning-90/20 border border-warning-80 rounded p-3 mt-4">
                    <div className="flex gap-2">
                        <div className="mt-0.5">
                            <div className="size-5 rounded-full bg-warning-50/20 flex items-center justify-center">
                                <span className="text-warning-50 text-xs font-bold">!</span>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <p className="text-xs font-medium text-warning-10">
                                Keep your master token secure
                            </p>
                            <p className="text-xs text-warning-30">
                                Never share your master token with anyone. It provides full
                                access to your account and should be treated like a password.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OAuthTokenSection;

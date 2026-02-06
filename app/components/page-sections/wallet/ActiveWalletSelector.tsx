"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
// TODO: Import from your web project's wallet context
// import { useActiveWallet } from "@/contexts/ActiveWalletContext";
// import { isExtensionAvailable } from "@/lib/bridge/signer";
import { ChevronUp, ChevronDown, ExternalLink, AlertCircle, RefreshCw, Plus, Copy, Check, LogOut, Wallet as WalletIcon } from "lucide-react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";


// =============================================================================
// TYPES - Define these based on your extension wallet integration
// =============================================================================
interface ExtensionAccount {
    address: string;
    name?: string;
}

interface ActiveWallet {
    address: string;
    name?: string;
}

// Placeholder hook - Replace with actual implementation
const useActiveWallet = () => ({
    activeWallet: null as ActiveWallet | null,
    extensionAccounts: [] as ExtensionAccount[],
    isLoading: false,
    isConnected: false,
    isDisconnected: false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    switchWallet: (_address: string) => { },
    truncateAddress: (addr: string, start = 6, end = 4) =>
        `${addr.slice(0, start)}...${addr.slice(-end)}`,
    refreshAccounts: () => { },
    silentRefreshAccounts: async () => { },
    clearActiveWallet: () => { },
    reconnectWallet: async () => { },
});

// Placeholder - Replace with actual extension detection
const isExtensionAvailable = () => false;

// =============================================================================
// COMPONENT
// =============================================================================
interface ActiveWalletSelectorProps {
    className?: string;
}

const WALLET_EXTENSIONS = [
    {
        name: "Polkadot.js",
        url: "https://polkadot.js.org/extension/",
        description: "Official Polkadot browser extension"
    },
    {
        name: "Talisman",
        url: "https://talisman.xyz/",
        description: "Feature-rich wallet for Polkadot & Ethereum"
    },
    {
        name: "SubWallet",
        url: "https://subwallet.app/",
        description: "All-in-one Polkadot, Substrate & Ethereum wallet"
    }
];

export function ActiveWalletSelector({ className }: ActiveWalletSelectorProps) {
    const {
        activeWallet,
        extensionAccounts,
        isLoading,
        isConnected,
        isDisconnected,
        switchWallet,
        truncateAddress,
        refreshAccounts,
        silentRefreshAccounts,
        clearActiveWallet,
        reconnectWallet,
    } = useActiveWallet();

    const [isOpen, setIsOpen] = useState(false);
    const [hasExtension, setHasExtension] = useState(false);
    const [hasAttemptedConnect, setHasAttemptedConnect] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Check for extension availability
    useEffect(() => {
        setHasExtension(isExtensionAvailable());
    }, []);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener("mousedown", handleClickOutside);
        }

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isOpen]);

    // Auto-connect once when component mounts
    useEffect(() => {
        if (!isConnected && !isLoading && hasExtension && !hasAttemptedConnect && !isDisconnected) {
            setHasAttemptedConnect(true);
            refreshAccounts();
        }
    }, [isConnected, isLoading, hasExtension, hasAttemptedConnect, isDisconnected, refreshAccounts]);

    const handleManualRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await silentRefreshAccounts();
        } finally {
            setIsRefreshing(false);
        }
    }, [silentRefreshAccounts]);

    const handleReconnect = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await reconnectWallet();
        } finally {
            setIsRefreshing(false);
        }
    }, [reconnectWallet]);

    const handleAccountSelect = (address: string) => {
        switchWallet(address);
        setIsOpen(false);
    };

    const openInExplorer = (address: string, e: React.MouseEvent) => {
        e.stopPropagation();
        window.open(`https://hipstats.com/accounts/${address}`, "_blank");
    };

    const copyAddress = async (address: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(address);
            setCopiedAddress(address);
            setTimeout(() => setCopiedAddress(null), 2000);
        } catch (err) {
            console.error("Failed to copy address:", err);
        }
    };

    const handleDisconnect = (e: React.MouseEvent) => {
        e.stopPropagation();
        clearActiveWallet();
        setIsOpen(false);
    };

    const truncateName = (name: string) => {
        if (name.length <= 12) return name;
        return `${name.slice(0, 6)}...${name.slice(-3)}`;
    };

    // Loading state
    if (isLoading) {
        return (
            <div className={cn("flex items-center gap-2", className)}>
                <div className="animate-spin h-4 w-4 border-2 border-primary-50 border-t-transparent rounded-full" />
                <span className="text-sm text-grey-50">Connecting wallet...</span>
            </div>
        );
    }

    // User manually disconnected - show Connect Wallet button
    if (isDisconnected && hasExtension) {
        return (
            <div className={cn("relative", className)} ref={dropdownRef}>
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-2 px-3 py-2"
                >
                    <div className="flex items-center gap-2">
                        <WalletIcon className="size-4 text-grey-50" />
                        <span className="font-geist text-base font-medium text-grey-60">Active Wallet</span>
                    </div>
                    <div className="flex items-center gap-2 pl-2 border border-primary-60 rounded p-1.5 bg-primary-95">
                        <span className="font-geist text-base font-medium text-primary-50">Connect Wallet</span>
                        {isOpen ? (
                            <ChevronUp className="size-5 text-primary-50" />
                        ) : (
                            <ChevronDown className="size-5 text-primary-50" />
                        )}
                    </div>
                </button>

                {/* Connect Wallet Dropdown */}
                {isOpen && (
                    <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-[380px] md:w-[420px] bg-white rounded-lg border border-grey-80 shadow-lg z-50 overflow-hidden">
                        <div className="p-6">
                            <div className="flex items-start gap-3 mb-5">
                                <div className="p-2 bg-primary-95 rounded-lg flex-shrink-0">
                                    <WalletIcon className="h-5 w-5 text-primary-50" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-base font-semibold text-grey-10 mb-1">
                                        Connect Your Wallet
                                    </h3>
                                    <p className="text-sm text-grey-50 leading-relaxed">
                                        Click the button below to connect your wallet and access your accounts.
                                    </p>
                                </div>
                            </div>

                            <button
                                onClick={handleReconnect}
                                disabled={isRefreshing}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition-colors font-medium text-sm disabled:opacity-60"
                            >
                                {isRefreshing ? (
                                    <>
                                        <RefreshCw className="size-4 animate-spin" />
                                        Connecting...
                                    </>
                                ) : (
                                    <>
                                        <WalletIcon className="size-4" />
                                        Connect Wallet
                                    </>
                                )}
                            </button>

                            <div className="mt-4 pt-4 border-t border-grey-90">
                                <p className="text-xs text-grey-50">
                                    <strong className="text-grey-30">Tip:</strong> This will show all accounts from your browser extension.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // No extension installed
    if (!hasExtension) {
        return (
            <div className={cn("relative", className)} ref={dropdownRef}>
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-2 px-3 py-2"
                >
                    <div className="flex items-center gap-2">
                        <WalletIcon className="size-4 text-grey-50" />
                        <span className="font-geist text-base font-medium text-grey-60">Active Wallet</span>
                    </div>
                    <div className="flex items-center gap-2 pl-2 border border-error-70 rounded p-1.5 bg-error-95">
                        <AlertCircle className="size-4 text-error-60" />
                        <span className="font-geist text-base font-medium text-error-60">Install Extension</span>
                        {isOpen ? (
                            <ChevronUp className="size-5 text-error-60" />
                        ) : (
                            <ChevronDown className="size-5 text-error-60" />
                        )}
                    </div>
                </button>

                {/* Extension Not Found Dropdown */}
                {isOpen && (
                    <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-[380px] md:w-[420px] bg-white rounded-lg border border-grey-80 shadow-lg z-50 overflow-hidden">
                        <div className="p-6">
                            <div className="flex items-start gap-3 mb-4">
                                <div className="p-2 bg-error-95 rounded-lg flex-shrink-0">
                                    <AlertCircle className="h-5 w-5 text-error-60" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-base font-semibold text-grey-10 mb-1">
                                        Wallet Extension Required
                                    </h3>
                                    <p className="text-sm text-grey-50 leading-relaxed">
                                        Please install a Polkadot wallet extension to connect your accounts and use Hippius features.
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2 mb-4">
                                {WALLET_EXTENSIONS.map((ext) => (
                                    <a
                                        key={ext.name}
                                        href={ext.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-between p-3 rounded-lg border border-grey-80 hover:border-primary-50 hover:bg-primary-98 transition-colors group"
                                    >
                                        <div className="flex-1">
                                            <div className="font-medium text-sm text-grey-10 group-hover:text-primary-50">
                                                {ext.name}
                                            </div>
                                            <div className="text-xs text-grey-50 mt-0.5">
                                                {ext.description}
                                            </div>
                                        </div>
                                        <ExternalLink className="h-4 w-4 text-grey-50 group-hover:text-primary-50 flex-shrink-0 ml-2" />
                                    </a>
                                ))}
                            </div>

                            <button
                                onClick={() => {
                                    setHasExtension(isExtensionAvailable());
                                    if (isExtensionAvailable()) {
                                        refreshAccounts();
                                    }
                                    setIsOpen(false);
                                }}
                                className="w-full px-4 py-2.5 border border-grey-80 text-grey-30 rounded-lg hover:bg-grey-95 transition-colors font-medium text-sm"
                            >
                                I&apos;ve Installed an Extension
                            </button>

                            <div className="mt-4 pt-4 border-t border-grey-90">
                                <p className="text-xs text-grey-50">
                                    <strong className="text-grey-30">Note:</strong> After installing, you may need to refresh this page to connect your wallet.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Extension installed but no accounts found
    if (isConnected && extensionAccounts.length === 0) {
        return (
            <div className={cn("relative", className)} ref={dropdownRef}>
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-2 px-3 py-2"
                >
                    <div className="flex items-center gap-2">
                        <WalletIcon className="size-4 text-grey-50" />
                        <span className="font-geist text-base font-medium text-grey-60">Active Wallet</span>
                    </div>
                    <div className="flex items-center gap-2 pl-2 border border-grey-70 rounded p-1.5 bg-grey-95">
                        <AlertCircle className="size-4 text-grey-50" />
                        <span className="font-geist text-base font-medium text-grey-40">No Accounts (0)</span>
                        {isOpen ? (
                            <ChevronUp className="size-5 text-grey-50" />
                        ) : (
                            <ChevronDown className="size-5 text-grey-50" />
                        )}
                    </div>
                </button>

                {/* No Accounts Dropdown */}
                {isOpen && (
                    <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-[380px] md:w-[420px] bg-white rounded-lg border border-grey-80 shadow-lg z-50 overflow-hidden">
                        <div className="p-6">
                            <div className="flex items-start gap-3 mb-5">
                                <div className="p-2 bg-primary-95 rounded-lg flex-shrink-0">
                                    <Plus className="h-5 w-5 text-primary-50" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-base font-semibold text-grey-10 mb-1">
                                        Add a Wallet Account
                                    </h3>
                                    <p className="text-sm text-grey-50 leading-relaxed">
                                        Your wallet extension is connected, but no accounts were found. Please add or create an account in your extension.
                                    </p>
                                </div>
                            </div>

                            {/* Steps */}
                            <div className="space-y-3 mb-5">
                                <div className="flex items-start gap-3 p-3 rounded-lg bg-grey-98 border border-grey-90">
                                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-50 text-white flex items-center justify-center text-xs font-bold">
                                        1
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-medium text-grey-20">
                                            Open your wallet extension
                                        </p>
                                        <p className="text-xs text-grey-50 mt-0.5">
                                            Click the extension icon in your browser toolbar
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 rounded-lg bg-grey-98 border border-grey-90">
                                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-50 text-white flex items-center justify-center text-xs font-bold">
                                        2
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-medium text-grey-20">
                                            Create or import an account
                                        </p>
                                        <p className="text-xs text-grey-50 mt-0.5">
                                            Use &ldquo;Create New Account&rdquo; or &ldquo;Import&rdquo; to add a wallet
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 rounded-lg bg-grey-98 border border-grey-90">
                                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-50 text-white flex items-center justify-center text-xs font-bold">
                                        3
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-medium text-grey-20">
                                            Grant access to Hippius
                                        </p>
                                        <p className="text-xs text-grey-50 mt-0.5">
                                            Make sure Hippius is allowed to see your accounts in the extension settings
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Refresh button */}
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={handleManualRefresh}
                                    disabled={isRefreshing}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition-colors font-medium text-sm disabled:opacity-60"
                                >
                                    <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
                                    {isRefreshing ? "Checking..." : "Refresh Accounts"}
                                </button>
                            </div>

                            {/* Help tip */}
                            <div className="mt-4 pt-4 border-t border-grey-90">
                                <p className="text-xs text-grey-50">
                                    <strong className="text-grey-30">Tip:</strong> After adding an account in your extension, click &ldquo;Refresh Accounts&rdquo; to see it here.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Extension installed but not yet connected
    if (!isConnected || extensionAccounts.length === 0) {
        return (
            <div className={cn("relative", className)} ref={dropdownRef}>
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-2 px-3 py-2"
                >
                    <div className="flex items-center gap-2">
                        <WalletIcon className="size-4 text-grey-50" />
                        <span className="font-geist text-base font-medium text-grey-60">Active Wallet</span>
                    </div>
                    <div className="flex items-center gap-2 pl-2 border border-grey-80 rounded p-1.5">
                        <span className="font-geist text-base font-medium text-grey-30">Connect Wallet</span>
                        {isOpen ? (
                            <ChevronUp className="size-5 text-grey-50" />
                        ) : (
                            <ChevronDown className="size-5 text-grey-50" />
                        )}
                    </div>
                </button>

                {/* No Accounts Dropdown */}
                {isOpen && (
                    <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-[340px] md:w-[380px] bg-white rounded-lg border border-grey-80 shadow-lg z-50 overflow-hidden">
                        <div className="p-6">
                            <div className="flex items-start gap-3 mb-4">
                                <div className="p-2 bg-grey-95 rounded-lg flex-shrink-0">
                                    <WalletIcon className="h-5 w-5 text-grey-50" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-base font-semibold text-grey-10 mb-1">
                                        No Wallet Accounts Found
                                    </h3>
                                    <p className="text-sm text-grey-50 leading-relaxed">
                                        {extensionAccounts.length === 0
                                            ? "Create or import a wallet account in your extension to continue."
                                            : "Please allow Hippius to access your wallet accounts."}
                                    </p>
                                </div>
                            </div>

                            <button
                                onClick={() => {
                                    refreshAccounts();
                                    setIsOpen(false);
                                }}
                                className="w-full px-4 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition-colors font-medium text-sm"
                            >
                                {extensionAccounts.length === 0 ? "Retry Connection" : "Connect Wallet"}
                            </button>

                            <div className="mt-4 pt-4 border-t border-grey-90">
                                <p className="text-xs text-grey-50">
                                    <strong className="text-grey-30">Need help?</strong> Make sure you&apos;ve created an account in your wallet extension and granted permissions to this site.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Has extension and accounts - show selector with stacked layout
    const isCopiedMain = activeWallet ? copiedAddress === activeWallet.address : false;

    return (
        <TooltipPrimitive.Provider delayDuration={200}>
            <div className={cn("relative", className)} ref={dropdownRef}>
                {/* Active Wallet Button - Stacked Layout: Name on top, Address below */}
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-2 px-3 py-2"
                >
                    <div className="flex items-center gap-2">
                        <WalletIcon className="size-4 text-grey-50" />
                        <span className="font-geist text-base font-medium text-grey-60">Active Wallet</span>
                    </div>
                    {activeWallet ? (
                        <div className="flex items-center gap-2 pl-2 border border-grey-80 rounded p-1.5">
                            <div className="w-2 h-2 rounded-full bg-success-50 flex-shrink-0" />
                            <div className="flex flex-col items-start">
                                {/* Wallet Name on top */}
                                <span className="font-geist text-sm font-medium text-grey-10 leading-tight">
                                    {truncateName(activeWallet.name || "Unnamed")}
                                </span>
                                {/* Address + Copy icon below */}
                                <div className="flex items-center gap-1">
                                    <TooltipPrimitive.Root>
                                        <TooltipPrimitive.Trigger asChild>
                                            <span className="text-xs text-grey-50 cursor-default">
                                                {truncateAddress(activeWallet.address, 6, 4)}
                                            </span>
                                        </TooltipPrimitive.Trigger>
                                        <TooltipPrimitive.Portal>
                                            <TooltipPrimitive.Content
                                                side="bottom"
                                                className="z-50 bg-white border border-grey-80 px-3 py-2 rounded-lg shadow-md max-w-[420px]"
                                                sideOffset={4}
                                            >
                                                <p className="text-xs font-medium text-grey-40 mb-1">Wallet Address</p>
                                                <p className="text-sm text-grey-20 break-all select-all cursor-text">
                                                    {activeWallet.address}
                                                </p>
                                                <TooltipPrimitive.Arrow className="fill-white" />
                                            </TooltipPrimitive.Content>
                                        </TooltipPrimitive.Portal>
                                    </TooltipPrimitive.Root>
                                    <TooltipPrimitive.Root>
                                        <TooltipPrimitive.Trigger asChild>
                                            <button
                                                onClick={(e) => copyAddress(activeWallet.address, e)}
                                                className="p-0.5 text-grey-50 hover:text-primary-50 transition-colors"
                                            >
                                                {isCopiedMain ? (
                                                    <Check className="size-3 text-success-50" />
                                                ) : (
                                                    <Copy className="size-3" />
                                                )}
                                            </button>
                                        </TooltipPrimitive.Trigger>
                                        <TooltipPrimitive.Portal>
                                            <TooltipPrimitive.Content
                                                side="bottom"
                                                className="z-50 bg-white text-grey-20 border border-grey-80 px-2 py-1 rounded text-xs shadow-md"
                                                sideOffset={4}
                                            >
                                                {isCopiedMain ? "Copied!" : "Copy address"}
                                                <TooltipPrimitive.Arrow className="fill-white" />
                                            </TooltipPrimitive.Content>
                                        </TooltipPrimitive.Portal>
                                    </TooltipPrimitive.Root>
                                </div>
                            </div>
                            {isOpen ? (
                                <ChevronUp className="size-5 text-grey-50" />
                            ) : (
                                <ChevronDown className="size-5 text-grey-50" />
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 pl-2 border border-primary-60 rounded p-1.5 bg-primary-95">
                            <span className="font-geist text-base font-medium text-primary-50">Select Wallet</span>
                            {isOpen ? (
                                <ChevronUp className="size-5 text-primary-50" />
                            ) : (
                                <ChevronDown className="size-5 text-primary-50" />
                            )}
                        </div>
                    )}
                </button>

                {/* Dropdown */}
                {isOpen && (
                    <div className="absolute right-2 top-full mt-0.5 w-[calc(100vw-2rem)] sm:w-[400px] md:w-[480px] bg-white rounded-lg border border-grey-80 shadow-lg z-50 overflow-hidden">
                        {/* Header */}
                        <div className="flex items-center justify-between px-4 py-4">
                            <span className="hidden sm:block font-geist text-lg font-medium text-grey-10">
                                {activeWallet ? "Your Wallets" : "Select a Wallet"}
                            </span>
                            <TooltipPrimitive.Root>
                                <TooltipPrimitive.Trigger asChild>
                                    <button
                                        onClick={handleDisconnect}
                                        className="p-1.5 text-grey-50 hover:text-error-50 hover:bg-error-95 rounded transition-colors"
                                    >
                                        <LogOut className="size-4" />
                                    </button>
                                </TooltipPrimitive.Trigger>
                                <TooltipPrimitive.Portal>
                                    <TooltipPrimitive.Content
                                        side="bottom"
                                        className="z-50 bg-white text-grey-20 border border-grey-80 px-2 py-1 rounded text-xs shadow-md"
                                        sideOffset={4}
                                    >
                                        Disconnect wallet
                                        <TooltipPrimitive.Arrow className="fill-white" />
                                    </TooltipPrimitive.Content>
                                </TooltipPrimitive.Portal>
                            </TooltipPrimitive.Root>
                        </div>

                        {/* Accounts List - Stacked layout: name on top, address + copy below */}
                        <div className="px-4 pb-4 space-y-3 max-h-[500px] overflow-y-auto">
                            {extensionAccounts.map((account) => {
                                const isActive = activeWallet?.address === account.address;
                                const isCopied = copiedAddress === account.address;
                                return (
                                    <div
                                        key={account.address}
                                        className="flex items-center justify-between px-3 py-3 border border-grey-80 rounded-lg hover:border-grey-70 transition-colors bg-white"
                                    >
                                        {/* Wallet Info - Stacked layout: name on top, address + copy below */}
                                        <div className="flex flex-col gap-1 flex-1 min-w-0">
                                            {/* Wallet Name */}
                                            <span className="font-geist text-base font-medium text-grey-20">
                                                {account.name || "Unnamed"}
                                            </span>
                                            {/* Address with copy icon */}
                                            <div className="flex items-center gap-1.5">
                                                <TooltipPrimitive.Root>
                                                    <TooltipPrimitive.Trigger asChild>
                                                        <span
                                                            className="text-sm text-grey-60 cursor-default"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            {truncateAddress(account.address, 8, 6)}
                                                        </span>
                                                    </TooltipPrimitive.Trigger>
                                                    <TooltipPrimitive.Portal>
                                                        <TooltipPrimitive.Content
                                                            side="bottom"
                                                            className="z-50 bg-white border border-grey-80 px-3 py-2 rounded-lg shadow-md max-w-[420px]"
                                                            sideOffset={4}
                                                        >
                                                            <p className="text-xs font-medium text-grey-40 mb-1">Wallet Address</p>
                                                            <p
                                                                className="text-sm text-grey-20 break-all select-all cursor-text"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                {account.address}
                                                            </p>
                                                            <TooltipPrimitive.Arrow className="fill-white" />
                                                        </TooltipPrimitive.Content>
                                                    </TooltipPrimitive.Portal>
                                                </TooltipPrimitive.Root>
                                                <TooltipPrimitive.Root>
                                                    <TooltipPrimitive.Trigger asChild>
                                                        <button
                                                            onClick={(e) => copyAddress(account.address, e)}
                                                            className="p-0.5 text-grey-50 hover:text-primary-50 transition-colors"
                                                        >
                                                            {isCopied ? (
                                                                <Check className="size-3.5 text-success-50" />
                                                            ) : (
                                                                <Copy className="size-3.5" />
                                                            )}
                                                        </button>
                                                    </TooltipPrimitive.Trigger>
                                                    <TooltipPrimitive.Portal>
                                                        <TooltipPrimitive.Content
                                                            side="bottom"
                                                            className="z-50 bg-white text-grey-20 border border-grey-80 px-2 py-1 rounded text-xs shadow-md"
                                                            sideOffset={4}
                                                        >
                                                            {isCopied ? "Copied!" : "Copy address"}
                                                            <TooltipPrimitive.Arrow className="fill-white" />
                                                        </TooltipPrimitive.Content>
                                                    </TooltipPrimitive.Portal>
                                                </TooltipPrimitive.Root>
                                            </div>
                                        </div>

                                        {/* Action Buttons */}
                                        <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                                            {/* Active/Select/Switch Wallet button */}
                                            {isActive ? (
                                                <div className="px-2 py-1 text-xs font-medium text-primary-50 border border-primary-80 bg-primary-90 hover:bg-primary-80 rounded">
                                                    Active Wallet
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => handleAccountSelect(account.address)}
                                                    className="px-2 py-1 text-xs font-medium text-grey-50 border border-grey-80 bg-grey-90 hover:bg-grey-80 rounded"
                                                >
                                                    {activeWallet ? "Switch Wallet" : "Select"}
                                                </button>
                                            )}

                                            {/* View on Hipstats */}
                                            <TooltipPrimitive.Root>
                                                <TooltipPrimitive.Trigger asChild>
                                                    <button
                                                        onClick={(e) => openInExplorer(account.address, e)}
                                                        className="p-1 bg-grey-100 border border-grey-80 rounded transition-colors hover:bg-grey-90"
                                                    >
                                                        <ExternalLink className="size-4 text-grey-10" />
                                                    </button>
                                                </TooltipPrimitive.Trigger>
                                                <TooltipPrimitive.Portal>
                                                    <TooltipPrimitive.Content
                                                        side="bottom"
                                                        className="z-50 bg-white text-grey-20 border border-grey-80 px-2 py-1 rounded text-xs shadow-md"
                                                        sideOffset={4}
                                                    >
                                                        View on Hipstats
                                                        <TooltipPrimitive.Arrow className="fill-white" />
                                                    </TooltipPrimitive.Content>
                                                </TooltipPrimitive.Portal>
                                            </TooltipPrimitive.Root>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Footer with helpful info */}
                        <div className="px-4 py-3 border-t border-grey-90 bg-grey-98">
                            <p className="text-xs text-grey-50">
                                Wallets are managed in your browser extension. Changes are detected automatically.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </TooltipPrimitive.Provider>
    );
}

export default ActiveWalletSelector;

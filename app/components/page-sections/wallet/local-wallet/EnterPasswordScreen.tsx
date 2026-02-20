"use client";

import React, { useState } from "react";
import { CardButton, Icons, Graphsheet } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasswordInput from "./PasswordInput";
import { ArrowRight, AlertCircle } from "lucide-react";

/**
 * Screen for entering password to unlock existing wallet
 */
const EnterPasswordScreen: React.FC = () => {
    const { unlockWallet, activeWallet, setSetupStep, hasWallets } = useLocalWallet();
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const handleUnlock = async () => {
        setError(null);

        if (!password) {
            setError("Please enter your password");
            return;
        }

        setIsLoading(true);

        try {
            console.log("[EnterPassword] Attempting to unlock wallet...");
            const pair = await unlockWallet(password);

            console.log("[EnterPassword] Unlock result:", pair ? "Success" : "Failed");

            if (!pair) {
                setError("Incorrect password. Please try again.");
                setPassword("");
            }
            // On success, unlockWallet sets setupStep to "ready" internally
            // The parent component will handle the transition
        } catch (err) {
            console.error("[EnterPassword] Failed to unlock wallet:", err);
            setError("Failed to unlock wallet. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateNew = () => {
        setSetupStep("create-mnemonic");
    };

    const handleImport = () => {
        setSetupStep("import-wallet");
    };

    // If no wallets exist but we're on enter password, redirect to welcome
    if (!hasWallets) {
        setSetupStep("welcome");
        return null;
    }

    return (
        <div className="flex flex-col items-center w-full max-w-[430px] mx-auto px-4 pt-16 pb-8">
            {/* Logo with Graphsheet background */}
            <div className="relative flex items-center justify-center mb-8 size-[100px]">
                <Graphsheet className="absolute inset-0 size-full rounded-full border border-grey-90" />
                <Icons.SplashHippiusLogo className="size-14 z-10" />
            </div>

            {/* Title */}
            <h1 className="text-2xl font-semibold text-grey-10 mb-2">
                Enter Your Password
            </h1>
            <p className="text-base text-grey-60 text-center mb-8">
                Enter your account password to confirm and get started
            </p>

            {/* Active Wallet Info */}
            {activeWallet && (
                <div className="w-full mb-6 p-3 bg-grey-98 border border-grey-80 rounded-lg">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary-90 flex items-center justify-center">
                            <Icons.Wallet className="size-4 text-primary-50" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-grey-10 truncate">
                                {activeWallet.name}
                            </p>
                            <p className="text-xs text-grey-50 truncate">
                                {activeWallet.address.slice(0, 8)}...
                                {activeWallet.address.slice(-6)}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Password Input */}
            <div className="w-full mb-6">
                <PasswordInput
                    value={password}
                    onChange={(val) => {
                        setPassword(val);
                        setError(null);
                    }}
                    label="Password"
                    placeholder="Enter your password"
                    disabled={isLoading}
                    autoFocus
                    onSubmit={handleUnlock}
                />
            </div>

            {/* Error */}
            {error && (
                <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
                    <AlertCircle className="size-4 flex-shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {/* Continue Button */}
            <CardButton
                className="w-full h-12 mb-6"
                onClick={handleUnlock}
                disabled={isLoading || !password}
                loading={isLoading}
            >
                <div className="flex items-center justify-center gap-2 text-lg font-medium">
                    {isLoading ? "Unlocking..." : "Continue to Wallet"}
                    {!isLoading && <ArrowRight className="size-5" />}
                </div>
            </CardButton>

            {/* Other Options */}
            <div className="w-full space-y-4 text-center">
                <button
                    onClick={handleCreateNew}
                    className="text-base text-grey-50 hover:text-grey-30 transition-colors"
                    disabled={isLoading}
                >
                    Don&apos;t have a wallet?{" "}
                    <span className="font-semibold text-grey-10">Create New Wallet</span>
                </button>

                <button
                    onClick={handleImport}
                    className="text-base text-grey-50 hover:text-grey-30 transition-colors block w-full"
                    disabled={isLoading}
                >
                    Have an existing wallet?{" "}
                    <span className="font-semibold text-grey-10">Import Your Wallet</span>
                </button>
            </div>
        </div>
    );
};

export default EnterPasswordScreen;

"use client";

import React, { useState } from "react";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasswordInput from "./PasswordInput";
import { ArrowRight, AlertCircle } from "lucide-react";
import { toast } from "sonner";

/**
 * Screen for setting password for a new wallet
 */
const CreatePasswordScreen: React.FC = () => {
    const { createWallet, setSetupStep } = useLocalWallet();
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const handleCreate = async () => {
        setError(null);

        // Validate password
        if (!password) {
            setError("Please enter a password");
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            return;
        }

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        // Get stored mnemonic and wallet name
        const mnemonic = sessionStorage.getItem("temp_mnemonic");
        const walletName =
            sessionStorage.getItem("temp_wallet_name") || "My Wallet";

        if (!mnemonic) {
            setError("No mnemonic found. Please go back and generate one.");
            return;
        }

        setIsLoading(true);

        try {
            const success = await createWallet(walletName, mnemonic, password);

            if (success) {
                // Clear temporary storage
                sessionStorage.removeItem("temp_mnemonic");
                sessionStorage.removeItem("temp_wallet_name");
                toast.success("Wallet created successfully!");
            } else {
                setError("Failed to create wallet. Please try again.");
            }
        } catch (err) {
            console.error("Failed to create wallet:", err);
            setError(
                err instanceof Error ? err.message : "Failed to create wallet"
            );
        } finally {
            setIsLoading(false);
        }
    };

    const handleAccessExisting = () => {
        sessionStorage.removeItem("temp_mnemonic");
        sessionStorage.removeItem("temp_wallet_name");
        setSetupStep("welcome");
    };

    const handleImport = () => {
        sessionStorage.removeItem("temp_mnemonic");
        sessionStorage.removeItem("temp_wallet_name");
        setSetupStep("import-wallet");
    };

    return (
        <div className="flex flex-col items-center w-full max-w-[430px] mx-auto px-4 pt-16 pb-8">
            {/* Logo with Graphsheet background */}
            <div className="relative flex items-center justify-center mb-8 size-[100px]">
                <Graphsheet className="absolute inset-0 size-full rounded-full border border-grey-90" />
                <Icons.SplashHippiusLogo className="size-14 z-10" />
            </div>

            {/* Title */}
            <h1 className="text-2xl font-semibold text-grey-10 mb-2">
                Create New Wallet
            </h1>
            <p className="text-base text-grey-60 text-center mb-8">
                Set a password to secure your wallet
            </p>

            {/* Password Inputs */}
            <div className="w-full space-y-4 mb-6">
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
                />

                <PasswordInput
                    value={confirmPassword}
                    onChange={(val) => {
                        setConfirmPassword(val);
                        setError(null);
                    }}
                    label="Confirm Password"
                    placeholder="Reenter password"
                    disabled={isLoading}
                    onSubmit={handleCreate}
                />
            </div>

            {/* Security Warning */}
            <div className="w-full mb-6 p-4 bg-warning-95 border border-warning-80 rounded-lg">
                <div className="flex items-start gap-3">
                    <AlertCircle className="size-5 text-warning-50 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-grey-30">
                        <p className="font-semibold text-grey-10 mb-1">Important Security Notice</p>
                        <ul className="space-y-1 list-disc list-inside">
                            <li>Your password is <strong>not stored anywhere</strong> and cannot be recovered</li>
                            <li>You must remember this password - it&apos;s required to sign all transactions</li>
                            <li>It encrypts and decrypts your mnemonic for secure signing</li>
                            <li>If you forget it, you&apos;ll need to re-import your wallet using your mnemonic</li>
                        </ul>
                    </div>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
                    <AlertCircle className="size-4 flex-shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {/* Create Button */}
            <CardButton
                className="w-full h-12 mb-6"
                onClick={handleCreate}
                disabled={isLoading}
                loading={isLoading}
            >
                <div className="flex items-center justify-center gap-2 text-lg font-medium">
                    {isLoading ? "Creating..." : "Create Wallet"}
                    {!isLoading && <ArrowRight className="size-5" />}
                </div>
            </CardButton>

            {/* Other Options */}
            <div className="w-full space-y-4 text-center">
                <button
                    onClick={handleAccessExisting}
                    className="text-base text-grey-50 hover:text-grey-30 transition-colors"
                    disabled={isLoading}
                >
                    Already have a wallet?{" "}
                    <span className="font-semibold text-grey-10">Access Wallet</span>
                </button>

                <button
                    onClick={handleImport}
                    className="text-base text-grey-50 hover:text-grey-30 transition-colors block w-full"
                    disabled={isLoading}
                >
                    Have an existing wallet?{" "}
                    <span className="font-semibold text-grey-10">Import Wallet</span>
                </button>
            </div>
        </div>
    );
};

export default CreatePasswordScreen;

"use client";

import React, { useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons } from "@/app/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasswordInput from "./PasswordInput";
import { X, AlertCircle, ShieldCheck } from "lucide-react";
import type { KeyringPair } from "@polkadot/keyring/types";

interface PasswordConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (pair: KeyringPair) => void;
    title?: string;
    description?: string;
    confirmLabel?: string;
    amount?: string;
    recipient?: string;
}

const PasswordConfirmDialog: React.FC<PasswordConfirmDialogProps> = ({
    open,
    onClose,
    onConfirm,
    title = "Confirm Transaction",
    description = "Enter your password to sign and submit this transaction",
    confirmLabel = "Confirm",
    amount,
    recipient,
}) => {
    const { activeWallet, unlockWallet, truncateAddress } = useLocalWallet();

    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const resetState = useCallback(() => {
        setPassword("");
        setError(null);
        setIsLoading(false);
    }, []);

    const handleClose = useCallback(() => {
        resetState();
        onClose();
    }, [resetState, onClose]);

    const handleConfirm = useCallback(async () => {
        if (!password) {
            setError("Please enter your password");
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            const pair = await unlockWallet(password);
            if (pair) {
                resetState();
                onConfirm(pair);
            } else {
                setError("Incorrect password");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to unlock wallet");
        } finally {
            setIsLoading(false);
        }
    }, [password, unlockWallet, onConfirm, resetState]);

    if (!activeWallet) {
        return null;
    }

    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
            <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[440px] h-fit">
                <Dialog.Title className="sr-only">{title}</Dialog.Title>

                {/* Close Button */}
                <button
                    onClick={handleClose}
                    className="absolute right-4 top-4 text-grey-50 hover:text-grey-30 transition-colors z-10"
                    disabled={isLoading}
                >
                    <X className="size-5" />
                </button>

                <div className="flex flex-col items-center px-6 py-8">
                    <AbstractIconWrapper className="size-16 text-primary-40 mb-6">
                        <ShieldCheck className="absolute size-6 text-primary-50" />
                    </AbstractIconWrapper>

                    <h2 className="text-xl font-semibold text-grey-10 mb-2">{title}</h2>
                    <p className="text-sm text-grey-60 text-center mb-6">{description}</p>

                    {/* Transaction Details */}
                    {(amount || recipient) && (
                        <div className="w-full bg-grey-95 rounded-lg p-4 mb-6 space-y-3">
                            {amount && (
                                <div className="flex justify-between items-center">
                                    <span className="text-sm text-grey-60">Amount</span>
                                    <span className="text-sm font-medium text-grey-10">{amount}</span>
                                </div>
                            )}
                            {recipient && (
                                <div className="flex justify-between items-center">
                                    <span className="text-sm text-grey-60">Recipient</span>
                                    <span className="text-sm font-medium text-grey-10">
                                        {truncateAddress(recipient, 8, 6)}
                                    </span>
                                </div>
                            )}
                            <div className="flex justify-between items-center pt-2 border-t border-grey-80">
                                <span className="text-sm text-grey-60">From Wallet</span>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-grey-50">
                                        {activeWallet.name}
                                    </span>
                                    <span className="text-xs text-grey-60">
                                        ({truncateAddress(activeWallet.address, 4, 4)})
                                    </span>
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
                            onSubmit={handleConfirm}
                        />
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
                            <AlertCircle className="size-4 flex-shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="w-full flex gap-3">
                        <CardButton
                            className="flex-1 h-12"
                            variant="secondary"
                            onClick={handleClose}
                            disabled={isLoading}
                        >
                            Cancel
                        </CardButton>
                        <CardButton
                            className="flex-1 h-12"
                            onClick={handleConfirm}
                            disabled={isLoading || !password}
                            loading={isLoading}
                        >
                            <div className="flex items-center justify-center gap-2">
                                <Icons.Send className="size-4" />
                                {confirmLabel}
                            </div>
                        </CardButton>
                    </div>
                </div>
            </DialogContainer>
        </Dialog.Root>
    );
};

export default PasswordConfirmDialog;

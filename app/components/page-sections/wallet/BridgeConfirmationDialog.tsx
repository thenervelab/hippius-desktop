"use client";

import * as Dialog from "@radix-ui/react-dialog";
import React, { useState } from "react";
import { Icons } from "@/components/ui";
import { ArrowRight, AlertCircle, CheckCircle } from "lucide-react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { PasswordInput } from "./local-wallet";

interface BridgeConfirmationDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (mnemonic: string) => void;
    loading: boolean;
    amount: string;
    direction: 'alpha-to-halpha' | 'halpha-to-alpha';
}

const BridgeConfirmationDialog: React.FC<BridgeConfirmationDialogProps> = ({
    open,
    onClose,
    onConfirm,
    loading,
    amount,
    direction,
}) => {
    const { activeWallet, getDecryptedMnemonic, hasWallets } = useLocalWallet();
    const [password, setPassword] = useState("");
    const [passwordError, setPasswordError] = useState<string | null>(null);

    const isAlphaToHAlpha = direction === 'alpha-to-halpha';

    const title = isAlphaToHAlpha
        ? "Bridge Alpha to hAlpha"
        : "Bridge hAlpha to Alpha";

    const sourceToken = isAlphaToHAlpha ? "ALPHA" : "hALPHA";
    const destToken = isAlphaToHAlpha ? "hALPHA" : "ALPHA";

    const showPasswordInput = hasWallets && activeWallet;

    const handleConfirm = () => {
        if (!showPasswordInput) {
            // No local wallet, proceed without password (legacy flow)
            onConfirm("");
            return;
        }

        if (!password) {
            setPasswordError("Please enter your password");
            return;
        }

        const mnemonic = getDecryptedMnemonic(password);
        if (!mnemonic) {
            setPasswordError("Incorrect password");
            return;
        }

        // Clear password after successful decryption
        setPassword("");
        setPasswordError(null);
        onConfirm(mnemonic);
    };

    const handleClose = () => {
        setPassword("");
        setPasswordError(null);
        onClose();
    };

    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && !loading && handleClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="bg-black/40 fixed inset-0 flex items-center justify-center data-[state=open]:animate-fade-in-0.3 z-[60]" />
                <Dialog.Content className="fixed top-1/2 left-1/2 w-[90%] max-w-lg -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 shadow-xl z-[70] animate-fade-in-0.2">
                    <div className="flex justify-between items-center mb-5">
                        <Dialog.Title className="text-xl font-semibold text-grey-10 flex items-center gap-2">
                            <Icons.Money className="text-primary-50 size-6" />
                            {title}
                        </Dialog.Title>
                        <Dialog.Close asChild>
                            <button
                                onClick={handleClose}
                                disabled={loading}
                                className="text-grey-50 hover:text-grey-30 disabled:opacity-50"
                            >
                                <Icons.CloseCircle className="size-6" />
                            </button>
                        </Dialog.Close>
                    </div>

                    <div className="mb-6 text-grey-10">
                        {/* Transaction Summary */}
                        <div className="bg-grey-90 rounded-lg mb-4 border border-grey-80 p-4">
                            <div className="flex items-center justify-center gap-3 mb-4">
                                <div className="text-center">
                                    <p className="text-lg font-semibold text-grey-10">{amount}</p>
                                    <p className="text-sm text-grey-50">{sourceToken}</p>
                                </div>
                                <ArrowRight className="size-5 text-primary-50" />
                                <div className="text-center">
                                    <p className="text-lg font-semibold text-grey-10">{amount}</p>
                                    <p className="text-sm text-grey-50">{destToken}</p>
                                </div>
                            </div>
                        </div>

                        {/* Important Info for Alpha to hAlpha */}
                        {isAlphaToHAlpha && (
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="size-5 text-blue-600 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <h4 className="font-semibold text-blue-800 mb-2">Multiple Wallet Confirmations Required</h4>
                                        <p className="text-sm text-blue-700 mb-3">
                                            This bridge operation requires <strong>3 wallet signatures</strong> on Bittensor:
                                        </p>
                                        <ol className="text-sm text-blue-700 space-y-2 list-decimal list-inside">
                                            <li className="flex items-start gap-2">
                                                <span className="flex-shrink-0 font-medium">1.</span>
                                                <span><strong>Add Proxy</strong> - Authorize the escrow contract on Bittensor</span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="flex-shrink-0 font-medium">2.</span>
                                                <span><strong>Deposit Alpha</strong> - Deposit your staked Alpha into the bridge contract</span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="flex-shrink-0 font-medium">3.</span>
                                                <span><strong>Remove Proxy</strong> - Revoke bridge access on Bittensor</span>
                                            </li>
                                        </ol>
                                        <p className="text-xs text-blue-600 mt-3">
                                            After these steps, guardians will mint hAlpha on Hippius.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Info for hAlpha to Alpha */}
                        {!isAlphaToHAlpha && (
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="size-5 text-blue-600 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <h4 className="font-semibold text-blue-800 mb-2">Bridge Information</h4>
                                        <p className="text-sm text-blue-700">
                                            Your hAlpha will be burned on Hippius and the equivalent Alpha will be released to your <strong>staked balance</strong> on Bittensor (not free balance).
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* What to expect */}
                        <div className="space-y-2">
                            <h4 className="font-medium text-grey-30 text-sm">What to expect:</h4>
                            <ul className="text-sm text-grey-50 space-y-1.5">
                                <li className="flex items-center gap-2">
                                    <CheckCircle className="size-4 text-green-500" />
                                    <span>Guardians will process your transaction</span>
                                </li>
                                <li className="flex items-center gap-2">
                                    <CheckCircle className="size-4 text-green-500" />
                                    <span>Track progress in the Bridge Transactions widget</span>
                                </li>
                                <li className="flex items-center gap-2">
                                    <CheckCircle className="size-4 text-green-500" />
                                    <span>Processing typically takes ~120 seconds</span>
                                </li>
                            </ul>
                        </div>

                        {/* Password Input */}
                        {showPasswordInput && (
                            <div className="mt-4">
                                <PasswordInput
                                    value={password}
                                    onChange={(val) => {
                                        setPassword(val);
                                        setPasswordError(null);
                                    }}
                                    label="Enter your wallet password to sign the transaction"
                                    placeholder="Enter wallet password"
                                    disabled={loading}
                                    autoFocus
                                    onSubmit={handleConfirm}
                                />
                                {passwordError && (
                                    <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-2">
                                        <AlertCircle className="size-4" />
                                        <span>{passwordError}</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end gap-3">
                        <button
                            onClick={handleClose}
                            disabled={loading}
                            className="px-5 py-2.5 border border-grey-80 rounded-lg text-grey-10 hover:bg-grey-95 transition disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={loading || (!!showPasswordInput && !password)}
                            className="px-5 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition disabled:opacity-50 flex items-center gap-2"
                        >
                            {loading ? (
                                <>
                                    <Icons.Loader className="size-4 animate-spin" />
                                    <span>Processing...</span>
                                </>
                            ) : (
                                `Confirm Bridge`
                            )}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
};

export default BridgeConfirmationDialog;

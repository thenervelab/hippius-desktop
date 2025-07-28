"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle, ShieldSecurity } from "@/components/ui/icons";
import { AbstractIconWrapper, RevealTextLine } from "@/app/components/ui";
import PasscodeInput from "../encryption-key/PasscodeInput";
import { Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

type Props = {
    open: boolean;
    onClose: () => void;
    title: string;
    description?: string;
    address?: string;
    seedInputRequired?: boolean;
    initialSeed?: string;
    onSubmit: (data: { seed?: string; passcode: string }) => Promise<{ success: boolean; error?: string }>;
    cancelLabel?: string;
    submitLabel?: string;
    successMessage?: string;
    passcodeLabel?: string;
};

export default function SeedPasscodeModal({
    open,
    onClose,
    title,
    description,
    seedInputRequired = true,
    initialSeed = "",
    onSubmit,
    cancelLabel = "Cancel",
    submitLabel = "Save Seed",
    successMessage = "Seed saved successfully",
    passcodeLabel = "Your passcode to encrypt seed",
}: Props) {
    const [seed, setSeed] = useState(initialSeed);
    const [seedError, setSeedError] = useState<string | null>(null);
    const [passcode, setPasscode] = useState("");
    const [showPasscode, setShowPasscode] = useState(false);
    const [passcodeError, setPasscodeError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (seedInputRequired && !seed.trim()) {
            setSeedError("Please enter a seed phrase");
            return;
        }

        if (seedInputRequired && !isMnemonicValid(seed.trim())) {
            setSeedError("Invalid seed phrase format");
            return;
        }

        if (!passcode) {
            setPasscodeError("Please enter your passcode");
            return;
        }

        setIsSubmitting(true);
        setPasscodeError(null);
        setSeedError(null);

        try {
            const result = await onSubmit({
                seed: seedInputRequired ? seed.trim() : undefined,
                passcode
            });

            if (result.success) {
                toast.success(successMessage);
                handleClose();
            } else {
                setPasscodeError(result.error || "Failed to process request. Please try again.");
            }
        } catch (error) {
            console.error("Error during submission:", error);
            setPasscodeError("Failed to process request. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleClose = () => {
        setSeed(initialSeed);
        setSeedError(null);
        setPasscode("");
        setShowPasscode(false);
        setPasscodeError(null);
        onClose();
    };

    const isMnemonicValid = (mnemonic: string): boolean => {
        const words = mnemonic.trim().split(/\s+/);
        return words.length === 12 || words.length === 24;
    };

    return (
        <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
                <Dialog.Content
                    className="
                        fixed left-1/2 top-1/2 z-50 
                        w-full max-w-sm sm:max-w-[488px] 
                        -translate-x-1/2 -translate-y-1/2
                        bg-white rounded-[8px]
                        shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
                        p-[16px]
                    "
                >
                    <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
                    <Dialog.Close asChild className="sm:hidden">
                        <button
                            aria-label="Close"
                            className="absolute top-11 right-4 text-grey-10 hover:text-grey-20"
                        >
                            <CloseCircle className="size-6" />
                        </button>
                    </Dialog.Close>

                    <div className="flex items-center sm:justify-center">
                        <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                            <AbstractIconWrapper className="size-10 rounded-2xl text-primary-50 ">
                                <ShieldSecurity className="absolute size-6 text-primary-50" />
                            </AbstractIconWrapper>
                        </div>
                    </div>

                    <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center pt-[16px]">
                        {title}
                    </Dialog.Title>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {description && (
                            <div className="text-grey-70 text-sm text-center">
                                <RevealTextLine rotate reveal={true} className="delay-300">
                                    {description}
                                </RevealTextLine>
                            </div>
                        )}

                        {seedInputRequired && (
                            <div className="space-y-2">
                                <Label htmlFor="seed" className="text-sm font-medium text-grey-70">
                                    Seed Phrase
                                </Label>
                                <div className="relative flex items-start w-full">
                                    <ShieldSecurity className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                                    <Input
                                        id="seed"
                                        placeholder="Enter seed phrase"
                                        value={seed}
                                        onChange={(e) => {
                                            setSeed(e.target.value);
                                            setSeedError(null);
                                        }}
                                        className="pl-11 border-grey-80 h-14 text-grey-30 w-full
                                            bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                                            hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
                                    />
                                </div>
                                {seedError && (
                                    <div className="flex text-error-70 text-sm font-medium items-center gap-2">
                                        <AlertCircle className="size-4 !relative" />
                                        <span>{seedError}</span>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="space-y-2">
                            <PasscodeInput
                                passcode={passcode}
                                onPasscodeChange={(value) => {
                                    setPasscode(value);
                                    setPasscodeError(null);
                                }}
                                showPasscode={showPasscode}
                                onToggleShowPasscode={() => setShowPasscode(!showPasscode)}
                                error={passcodeError}
                                inView={true}
                                placeholder="Enter your passcode"
                                label={passcodeLabel}
                                className="mt-0 w-full"
                                errorClassName="w-full mt-0"
                            />
                        </div>

                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10 hover:bg-grey-90 transition text-lg font-medium"
                            >
                                {cancelLabel}
                            </button>
                            <button
                                type="submit"
                                className="w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition"
                                disabled={isSubmitting}
                            >
                                <div className="py-2.5 rounded border border-primary-40 text-lg">
                                    {isSubmitting ? 'Saving...' : submitLabel}
                                </div>
                            </button>
                        </div>
                    </form>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

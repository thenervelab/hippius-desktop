"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { Graphsheet, RevealTextLine } from "@/app/components/ui";
import PasscodeInput from "@/components/page-sections/settings/encryption-key/PasscodeInput";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { getSubAccountSeed } from "@/app/lib/helpers/subAccountSeedsDb";
import { ShieldSecurity } from "@/components/ui/icons";

type Props = {
    open: boolean;
    onClose: () => void;
    address: string;
};

export default function ViewSeedModal({
    open,
    onClose,
    address,
}: Props) {
    const [passcode, setPasscode] = useState("");
    const [showPasscode, setShowPasscode] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [seed, setSeed] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!passcode) {
            setError("Please enter your passcode");
            return;
        }

        setIsValidating(true);
        setError(null);

        try {
            const result = await getSubAccountSeed(address, passcode);
            setSeed(result);
        } catch (error) {
            console.error("Failed to retrieve seed:", error);
            setError("Incorrect passcode. Please try again.");
        } finally {
            setIsValidating(false);
        }
    };

    const handleClose = () => {
        setPasscode("");
        setShowPasscode(false);
        setError(null);
        setSeed(null);
        onClose();
    };

    const copyToClipboard = async () => {
        if (!seed) return;

        try {
            await navigator.clipboard.writeText(seed);
            setCopied(true);
            toast.success("Seed phrase copied to clipboard");
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error("Failed to copy seed to clipboard:", error);
            toast.error("Failed to copy to clipboard");
        }
    };

    const addressShort = address
        ? `${address.slice(0, 12)}...${address.slice(-12)}`
        : "";

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
                            <Graphsheet
                                majorCell={{
                                    lineColor: [31, 80, 189, 1],
                                    lineWidth: 2,
                                    cellDim: 40,
                                }}
                                minorCell={{
                                    lineColor: [31, 80, 189, 1],
                                    lineWidth: 2,
                                    cellDim: 40,
                                }}
                                className="absolute w-full h-full inset-0 duration-300 opacity-10"
                            />
                            <ShieldSecurity className="size-10 text-primary-50" />
                        </div>
                    </div>

                    <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center py-[16px]">
                        {seed ? 'Sub Account Seed' : 'View Sub Account Seed'}
                    </Dialog.Title>

                    {!seed ? (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <PasscodeInput
                                passcode={passcode}
                                onPasscodeChange={setPasscode}
                                showPasscode={showPasscode}
                                onToggleShowPasscode={() => setShowPasscode(!showPasscode)}
                                error={error}
                                inView={true}
                                placeholder="Enter your passcode"
                                label="Enter your passcode to view seed"
                                className="mt-0 w-full"
                                errorClassName="w-full mt-0"
                            />

                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={handleClose}
                                    className="w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10 hover:bg-grey-90 transition text-lg font-medium"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition"
                                    disabled={isValidating}
                                >
                                    <div className="py-2.5 rounded border border-primary-40 text-lg">
                                        {isValidating ? 'Validating...' : 'View Seed'}
                                    </div>
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="space-y-6">
                            <div className="text-grey-70 text-sm text-center mb-4">
                                <RevealTextLine rotate reveal={true} className="delay-300">
                                    <div className="flex">
                                        Seed phrase for sub account:
                                        <span className="font-medium text-grey-10">{addressShort}</span>
                                    </div>
                                </RevealTextLine>
                            </div>

                            <div className="p-4 shadow-[0_0_0_4px_rgba(10,10,10,0.05)] rounded-lg border border-grey-80 text-grey-30 gap-2 flex justify-between items-start">
                                <ShieldSecurity className="text-grey-60 w-[24px] h-[24px]" />
                                <span className="text-base font-medium break-all text-grey-20 flex-grow">
                                    {seed}
                                </span>
                                <Button
                                    type="button"
                                    onClick={copyToClipboard}
                                    className={cn(
                                        "h-auto hover:bg-transparent w-10",
                                        copied ? "text-green-600" : "text-grey-60 hover:text-grey-70"
                                    )}
                                    variant="ghost"
                                >
                                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </Button>
                            </div>

                            <div className="flex justify-end">
                                <button
                                    type="button"
                                    onClick={handleClose}
                                    className="w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition"
                                >
                                    <div className="py-2.5 rounded border border-primary-40 text-lg">
                                        Close
                                    </div>
                                </button>
                            </div>
                        </div>
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
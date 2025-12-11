"use client";

import React, { useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Graphsheet as GraphSheet } from "@/components/ui";

import { ChevronDown, CloseCircle, HippiusLogo } from "@/components/ui/icons";
import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectGroup,
    SelectScrollUpButton,
    SelectScrollDownButton,
} from "@/components/ui/select/Select2";
import { cn } from "@/lib/utils";
import { format, addDays, addYears } from "date-fns";
import { toast } from "sonner";
import { ExpiryOption, EXPIRY_OPTIONS, MasterTokenCreateResponse } from "@/app/lib/types/masterToken";
import TokenCredentialsDisplay from "./TokenCredentialsDisplay";
import FutureDateSelector from "./FutureDateSelectorDialog";

type Props = {
    open: boolean;
    onClose: () => void;
    onCreateToken: (data: { name: string; expires_at: string }) => Promise<MasterTokenCreateResponse>;
    isCreating: boolean;
};

const CreateMasterTokenDialog = React.memo(function CreateMasterTokenDialog({
    open,
    onClose,
    onCreateToken,
    isCreating,
}: Props) {
    const [name, setName] = useState("");
    const [nameError, setNameError] = useState("");
    const [expiryOption, setExpiryOption] = useState<ExpiryOption>("30_days");
    const [customDate, setCustomDate] = useState<Date | undefined>(undefined);

    // Result state
    const [createdToken, setCreatedToken] = useState<MasterTokenCreateResponse | null>(null);

    // Reset state when dialog closes
    React.useEffect(() => {
        if (!open) {
            setName("");
            setNameError("");
            setExpiryOption("30_days");
            setCustomDate(undefined);
            setCreatedToken(null);
        }
    }, [open]);

    const validateName = useCallback((value: string) => {
        if (!value.trim()) {
            setNameError("Name is required");
            return false;
        }
        if (value.length < 2) {
            setNameError("Name must be at least 2 characters");
            return false;
        }
        if (value.length > 100) {
            setNameError("Name must be less than 100 characters");
            return false;
        }
        setNameError("");
        return true;
    }, []);

    const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setName(value);
        if (value) validateName(value);
    }, [validateName]);

    const getExpiryDate = useCallback((): Date => {
        const now = new Date();
        const option = EXPIRY_OPTIONS.find((o) => o.value === expiryOption);

        if (expiryOption === "custom" && customDate) {
            return customDate;
        }

        if (option?.days) {
            if (option.days === 365) {
                return addYears(now, 1);
            }
            return addDays(now, option.days);
        }

        // Default to 30 days
        return addDays(now, 30);
    }, [expiryOption, customDate]);

    const handleCreateToken = async () => {
        if (!validateName(name)) {
            return;
        }

        if (expiryOption === "custom" && !customDate) {
            toast.error("Please select a custom expiry date");
            return;
        }

        try {
            const expiryDate = getExpiryDate();
            const result = await onCreateToken({
                name: name.trim(),
                expires_at: expiryDate.toISOString(),
            });
            setCreatedToken(result);
        } catch (error) {
            console.error("Failed to create master token:", error);
            // Error toast is handled in the hook
        }
    };



    const handleClose = () => {
        onClose();
    };

    const handleExpiryChange = (value: ExpiryOption) => {
        setExpiryOption(value);
        if (value !== "custom") {
            setCustomDate(undefined);
        }
    };

    return (
        <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
                <Dialog.Content
                    className="
                        fixed left-1/2 top-1/2 z-50 
                        w-full max-w-sm sm:max-w-[520px] 
                        -translate-x-1/2 -translate-y-1/2
                        bg-white rounded-[8px]
                        shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
                        p-4
                        !border-0 !outline-none
                        focus:!border-0 focus:!outline-none
                        focus-visible:!border-0 focus-visible:!outline-none
                        max-h-[90vh] overflow-y-auto
                    "
                >
                    <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
                    <Dialog.Close asChild className="sm:hidden">
                        <button
                            aria-label="Close"
                            className="absolute top-11 right-4 text-grey-10 hover:text-grey-20"
                            onClick={handleClose}
                        >
                            <CloseCircle className="size-6" />
                        </button>
                    </Dialog.Close>

                    {/* Icon */}
                    <div className="flex items-center sm:justify-center mb-4 mt-3 sm:mt-0">
                        <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                            <GraphSheet
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
                                className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-10 hidden sm:block"
                            />
                            <div className="flex items-center justify-center size-8 bg-primary-50 rounded-[8px] relative">
                                <HippiusLogo className="size-5 text-white" />
                            </div>
                        </div>
                    </div>

                    <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center mb-4">
                        {createdToken ? "Master Token Created" : "Create Master Token"}
                    </Dialog.Title>

                    <div className="space-y-4">
                        {!createdToken ? (
                            <>
                                {/* Name Field */}
                                <div>
                                    <label className="text-sm font-medium text-grey-70">
                                        Token Name
                                    </label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={handleNameChange}
                                        placeholder="e.g., Production Token"
                                        className={cn(
                                            "mt-2 w-full bg-grey-100 text-grey-60 placeholder-grey-60 border p-4 rounded-[8px]",
                                            "focus:outline-none focus:border-grey-80 text-base font-medium",
                                            nameError ? "border-error-60" : "border-grey-80"
                                        )}
                                    />
                                    {nameError && (
                                        <p className="mt-1 text-error-60 text-sm">{nameError}</p>
                                    )}
                                </div>

                                {/* Expiry Selection */}
                                <div>
                                    <label className="text-sm font-medium text-grey-70">
                                        Token Expiry
                                    </label>
                                    <div className="mt-2">
                                        <Select
                                            value={expiryOption}
                                            onValueChange={(v) => handleExpiryChange(v as ExpiryOption)}
                                        >
                                            <SelectTrigger
                                                className="
                          w-full flex items-center justify-between relative
                          bg-grey-100 border border-grey-80 rounded-[8px]
                          px-4 py-3 text-base font-medium text-grey-60
                          h-[60px] focus:outline-none focus:border-grey-80
                        "
                                            >
                                                <SelectValue placeholder="Select expiry duration" />
                                                <ChevronDown
                                                    className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 pointer-events-none"
                                                />
                                            </SelectTrigger>

                                            <SelectContent
                                                className="
                          bg-grey-100 border border-grey-80 rounded-[8px]
                          shadow-lg max-h-60 overflow-auto z-[100] p-0
                        "
                                            >
                                                <SelectScrollUpButton />
                                                <SelectPrimitive.Viewport className="p-0">
                                                    <SelectGroup>
                                                        {EXPIRY_OPTIONS.map((option) => (
                                                            <SelectPrimitive.Item
                                                                key={option.value}
                                                                value={option.value}
                                                                className="
                                  relative flex items-center
                                  px-4 py-3
                                  text-base font-medium text-grey-60
                                  cursor-pointer
                                  outline-none
                                  hover:bg-grey-90 hover:text-grey-10
                                  focus:bg-grey-90 focus:text-grey-10
                                  data-[highlighted]:bg-grey-90 data-[highlighted]:text-grey-10
                                  data-[selected]:bg-grey-90 data-[selected]:text-grey-10
                                  transition-colors duration-150
                                "
                                                            >
                                                                <SelectPrimitive.ItemText>
                                                                    {option.label}
                                                                </SelectPrimitive.ItemText>
                                                            </SelectPrimitive.Item>
                                                        ))}
                                                    </SelectGroup>
                                                </SelectPrimitive.Viewport>
                                                <SelectScrollDownButton />
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                {/* Custom Date Picker */}
                                {expiryOption === "custom" && (
                                    <div>
                                        <label className="text-sm font-medium text-grey-70">
                                            Select Date
                                        </label>
                                        <div className="mt-2">
                                            <FutureDateSelector
                                                selectedDate={customDate}
                                                onDateSelect={(date) => setCustomDate(date)}
                                                placeholder="Pick a future date"
                                            />
                                        </div>
                                    </div>
                                )}

                                <p className="text-grey-60 text-sm">
                                    Token will expire on:{" "}
                                    <span className="font-medium text-grey-10">
                                        {format(getExpiryDate(), "PPP 'at' p")}
                                    </span>
                                </p>
                            </>
                        ) : (
                            <TokenCredentialsDisplay
                                accessKeyId={createdToken.access_key_id || createdToken.accessKeyId || ""}
                                secret={createdToken.secret_access_key || createdToken.secretAccessKey || createdToken.secret || ""}
                                showWarning={true}
                                warningTitle="⚠️ Important Information"
                                warningItems={[
                                    "The secret access key will <strong>not</strong> be displayed again",
                                    "Save both credentials securely before closing this dialog",
                                    "You can rotate the token later to generate a new secret"
                                ]}
                            />
                        )}
                    </div>

                    <div className="mt-6 space-y-3">
                        {!createdToken ? (
                            <>
                                <button
                                    onClick={handleCreateToken}
                                    className="
                      w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                      hover:bg-primary-40 transition
                      disabled:opacity-50 disabled:cursor-not-allowed
                  "
                                    disabled={isCreating || !name.trim() || !!nameError}
                                >
                                    <div className="py-2.5 rounded border border-primary-40 text-lg">
                                        {isCreating ? "Creating..." : "Create Master Token"}
                                    </div>
                                </button>
                                <button
                                    onClick={onClose}
                                    className="
                    w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10
                    hover:bg-grey-80 transition
                    text-lg font-medium hidden sm:block
                  "
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={handleClose}
                                className="
                  w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                  hover:bg-primary-40 transition
                "
                            >
                                <div className="py-2.5 rounded border border-primary-40 text-lg">
                                    I&apos;ve Saved My Token
                                </div>
                            </button>
                        )}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
});

export default CreateMasterTokenDialog;

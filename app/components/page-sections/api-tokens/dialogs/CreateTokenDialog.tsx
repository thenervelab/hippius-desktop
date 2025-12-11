"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, CloseCircle } from "@/components/ui/icons";
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
import { useApiBuckets } from "@/app/lib/hooks/api/useApiBuckets";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { TokenPermission } from "@/app/lib/types/apiToken";
import FutureDateSelector from "@/components/page-sections/dialogs/FutureDateSelectorDialog";
import { format } from "date-fns";


interface CreateTokenDialogProps {
    open: boolean;
    onClose: () => void;
    onSubmit: (data: {
        tokenName: string;
        permission: string;
        applyToAll: boolean;
        selectedBuckets?: string[];
        lifespan: string;
        customDate?: Date;
    }) => void;
    isCreating?: boolean;
}

const PERMISSIONS: TokenPermission[] = [
    "Object Read & Write",
    "Object Read Only",
];

type LifespanOption = "7 days" | "30 days" | "1 year" | "Custom";

const LIFESPANS: LifespanOption[] = [
    "7 days",
    "30 days",
    "1 year",
    "Custom",
];

const CreateTokenDialog = React.memo(function CreateTokenDialog({
    open,
    onClose,
    onSubmit,
    isCreating = false,
}: CreateTokenDialogProps) {
    const [tokenName, setTokenName] = React.useState("");
    const [selectedPermission, setSelectedPermission] = React.useState<TokenPermission>("Object Read & Write");
    const [selectedBuckets, setSelectedBuckets] = React.useState<string[]>([]);
    const [selectedLifespan, setSelectedLifespan] = React.useState<LifespanOption>("7 days");
    const [customDate, setCustomDate] = React.useState<Date | null>(null);
    const [showBucketDropdown, setShowBucketDropdown] = React.useState(false);
    const bucketDropdownRef = React.useRef<HTMLDivElement>(null);
    const { oauthSession } = useWalletAuth();



    const { buckets } = useApiBuckets(oauthSession?.token || null);


    // Close dropdown when clicking outside
    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (bucketDropdownRef.current && !bucketDropdownRef.current.contains(event.target as Node)) {
                setShowBucketDropdown(false);
            }
        };

        if (showBucketDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showBucketDropdown]);

    // Reset form when dialog opens/closes
    React.useEffect(() => {
        if (open) {
            setTokenName("");
            setSelectedPermission("Object Read & Write");
            setSelectedBuckets([]);
            setSelectedLifespan("7 days");
            setCustomDate(null);
            setShowBucketDropdown(false);
        }
    }, [open]);

    const handleBucketToggle = React.useCallback((bucketName: string) => {
        setSelectedBuckets((prev) =>
            prev.includes(bucketName)
                ? prev.filter((b) => b !== bucketName)
                : [...prev, bucketName]
        );
    }, []);

    const handleTokenNameChange = React.useCallback((name: string) => {
        setTokenName(name);
    }, []);

    const handlePermissionChange = React.useCallback((permission: TokenPermission) => {
        setSelectedPermission(permission);
    }, []);

    const handleLifespanChange = React.useCallback((lifespan: LifespanOption) => {
        setSelectedLifespan(lifespan);
        if (lifespan !== "Custom") {
            setCustomDate(null);
        }
    }, []);

    const handleSubmit = React.useCallback(() => {
        if (!tokenName.trim()) return;

        if (selectedBuckets.length === 0) {
            return;
        }

        if (selectedLifespan === "Custom" && !customDate) {
            return;
        }

        onSubmit({
            tokenName: tokenName.trim(),
            permission: selectedPermission,
            applyToAll: false,
            selectedBuckets: selectedBuckets,
            lifespan: selectedLifespan,
            customDate: selectedLifespan === "Custom" ? customDate ?? undefined : undefined,
        });
    }, [tokenName, selectedPermission, selectedBuckets, selectedLifespan, customDate, onSubmit]);

    return (
        <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
                <Dialog.Content
                    className="
            fixed left-1/2 top-1/2 z-50 
            w-full max-w-sm sm:max-w-[488px] 
            -translate-x-1/2 -translate-y-1/2
            bg-white rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            p-4
            !border-0 !outline-none
            focus:!border-0 focus:!outline-none
            focus-visible:!border-0 focus-visible:!outline-none
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

                    <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center mb-4">
                        Create Sub Token
                    </Dialog.Title>

                    <div className="space-y-4">
                        {/* Token Name */}
                        <div>
                            <label className="text-sm font-medium text-grey-70">
                                Token Name
                            </label>
                            <input
                                type="text"
                                value={tokenName}
                                onChange={(e) => handleTokenNameChange(e.target.value)}
                                placeholder="Choose a name for your token"
                                className={cn(
                                    "mt-2 w-full bg-grey-100 text-grey-60 placeholder-grey-60 border border-grey-80 p-4 rounded-[8px]",
                                    "focus:outline-none focus:border-grey-80 text-base font-medium"
                                )}
                            />
                        </div>

                        {/* Permissions */}
                        <div>
                            <label className="text-sm font-medium text-grey-70">
                                Permissions
                            </label>
                            <div className="mt-2">
                                <Select key={selectedPermission} value={selectedPermission} onValueChange={handlePermissionChange}>
                                    <SelectTrigger
                                        className="
                                            w-full flex items-center justify-between relative
                                            bg-grey-100 border border-grey-80 rounded-[8px]
                                            px-4 py-3 text-base font-medium text-grey-60
                                            h-[56px] focus:outline-none focus:border-grey-80
                                        "
                                    >
                                        <SelectValue placeholder="Select permission level" />
                                        <ChevronDown
                                            className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 pointer-events-none"
                                        />
                                    </SelectTrigger>

                                    <SelectContent
                                        className="
                      bg-grey-100 border border-grey-80 rounded-[8px]
                      shadow-lg max-h-60 overflow-auto z-50 p-0
                    "
                                    >
                                        <SelectScrollUpButton />
                                        <SelectPrimitive.Viewport className="p-0">
                                            <SelectGroup>
                                                {PERMISSIONS.map((permission) => (
                                                    <SelectPrimitive.Item
                                                        key={permission}
                                                        value={permission}
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
                              data-[state=checked]:bg-grey-90 data-[state=checked]:text-grey-10
                              transition-colors duration-150
                            "
                                                    >
                                                        <SelectPrimitive.ItemText>{permission}</SelectPrimitive.ItemText>
                                                    </SelectPrimitive.Item>
                                                ))}
                                            </SelectGroup>
                                        </SelectPrimitive.Viewport>
                                        <SelectScrollDownButton />
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        {/* Specify Bucket */}
                        <div>
                            <label className="text-sm font-medium text-grey-70">
                                Select Buckets
                            </label>
                            <div className="relative mt-2" ref={bucketDropdownRef}>
                                <button
                                    type="button"
                                    onClick={() => setShowBucketDropdown(!showBucketDropdown)}
                                    className="
                                        w-full flex items-center justify-between relative
                                        bg-grey-100 border border-grey-80 rounded-[8px]
                                        px-4 py-3 text-base font-normal text-grey-60
                                        h-[56px] focus:outline-none focus:border-grey-70
                                    "
                                >
                                    <span className={selectedBuckets.length === 0 ? "text-grey-60" : "text-grey-10"}>
                                        {selectedBuckets.length === 0
                                            ? "Select the buckets for this token"
                                            : `${selectedBuckets.length} bucket${selectedBuckets.length > 1 ? "s" : ""} selected`}
                                    </span>
                                    <ChevronDown className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 pointer-events-none" />
                                </button>

                                {showBucketDropdown && (
                                    <div className="
                                        absolute z-10 w-full mt-2 
                                        bg-white border border-grey-80 rounded-[8px] 
                                        shadow-lg max-h-[200px] overflow-y-auto
                                    ">
                                        {buckets.length === 0 ? (
                                            <div className="px-4 py-3 text-grey-60 text-base">
                                                No buckets available
                                            </div>
                                        ) : (
                                            buckets.map((bucket) => (
                                                <label
                                                    key={bucket.name}
                                                    className="
                                                        flex items-center gap-x-3 px-4 py-3 
                                                        hover:bg-grey-90 cursor-pointer
                                                        transition-colors duration-150
                                                        border-b border-grey-90 last:border-b-0
                                                    "
                                                    onClick={() => handleBucketToggle(bucket.name)}
                                                >
                                                    <div className={cn(
                                                        "h-5 w-5 rounded flex items-center justify-center border-2 transition-colors",
                                                        selectedBuckets.includes(bucket.name)
                                                            ? "bg-primary-50 border-primary-50"
                                                            : "bg-white border-grey-80"
                                                    )}>
                                                        {selectedBuckets.includes(bucket.name) && (
                                                            <svg
                                                                className="w-3.5 h-3.5 text-white"
                                                                fill="none"
                                                                viewBox="0 0 24 24"
                                                                stroke="currentColor"
                                                                strokeWidth={3}
                                                            >
                                                                <path
                                                                    strokeLinecap="round"
                                                                    strokeLinejoin="round"
                                                                    d="M5 13l4 4L19 7"
                                                                />
                                                            </svg>
                                                        )}
                                                    </div>
                                                    <span className="text-grey-10 text-base font-normal break-all">{bucket.name.length > 30 ? bucket.name.slice(0, 14) + "..." + bucket.name.slice(-16) : bucket.name}</span>
                                                </label>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Token Lifespan */}
                        <div>
                            <label className="text-sm font-medium text-grey-70">
                                Token Lifespan
                            </label>
                            <div className="mt-2">
                                <Select key={selectedLifespan} value={selectedLifespan} onValueChange={handleLifespanChange}>
                                    <SelectTrigger
                                        className="
                      w-full flex items-center justify-between relative
                      bg-grey-100 border border-grey-80 rounded-[8px]
                      px-4 py-3 text-base font-medium text-grey-60
                      h-[56px] focus:outline-none focus:border-grey-80
                    "
                                    >
                                        <SelectValue placeholder="Select token lifespan" />
                                        <ChevronDown
                                            className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 pointer-events-none"
                                        />
                                    </SelectTrigger>

                                    <SelectContent
                                        className="
                      bg-grey-100 border border-grey-80 rounded-[8px]
                      shadow-lg max-h-60 overflow-auto z-50 p-0
                    "
                                    >
                                        <SelectScrollUpButton />
                                        <SelectPrimitive.Viewport className="p-0">
                                            <SelectGroup>
                                                {LIFESPANS.map((lifespan) => (
                                                    <SelectPrimitive.Item
                                                        key={lifespan}
                                                        value={lifespan}
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
                              data-[state=checked]:bg-grey-90 data-[state=checked]:text-grey-10
                              transition-colors duration-150
                            "
                                                    >
                                                        <SelectPrimitive.ItemText>{lifespan}</SelectPrimitive.ItemText>
                                                    </SelectPrimitive.Item>
                                                ))}
                                            </SelectGroup>
                                        </SelectPrimitive.Viewport>
                                        <SelectScrollDownButton />
                                    </SelectContent>
                                </Select>
                            </div>
                            {selectedLifespan === "Custom" && (
                                <div className="mt-3">
                                    <FutureDateSelector
                                        selectedDate={customDate ?? undefined}
                                        onDateSelect={setCustomDate}
                                    />
                                    {customDate && (
                                        <p className="mt-2 text-sm text-grey-60">
                                            Token expires: {format(customDate, "MMMM d, yyyy")}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="mt-6 space-y-3">
                        <button
                            onClick={handleSubmit}
                            className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition
                disabled:opacity-50 disabled:cursor-not-allowed
              "
                            disabled={isCreating || !tokenName.trim() || selectedBuckets.length === 0 || (selectedLifespan === "Custom" && !customDate)}
                        >
                            <div className="py-2.5 rounded border border-primary-40 text-lg">
                                {isCreating ? "Creating..." : "Create Sub Token"}
                            </div>
                        </button>
                        <Dialog.Close asChild>
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
                        </Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
});

export default CreateTokenDialog;

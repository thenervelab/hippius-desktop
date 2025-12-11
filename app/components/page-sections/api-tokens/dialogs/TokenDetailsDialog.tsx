"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Check } from "lucide-react";
import { CloseCircle } from "@/components/ui/icons";
import { ApiToken } from "@/app/lib/types/apiToken";
import { toast } from "sonner";

interface TokenDetailsDialogProps {
    open: boolean;
    onClose: () => void;
    token: ApiToken | null;
    isRotated?: boolean; // Flag to show "Token Rotated" instead of "Token Created"
}

const TokenDetailsDialog = React.memo(function TokenDetailsDialog({
    open,
    onClose,
    token,
    isRotated = false,
}: TokenDetailsDialogProps) {
    const [copiedField, setCopiedField] = React.useState<string | null>(null);

    const handleCopy = async (text: string, fieldName: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(fieldName);
            toast.success(`${fieldName} copied to clipboard`);
            setTimeout(() => setCopiedField(null), 2000);
        } catch {
            toast.error("Failed to copy to clipboard");
        }
    };

    if (!token) return null;

    const title = isRotated ? "Token Rotated Successfully" : "Token Created Successfully";
    const subtitle = isRotated
        ? "Your token has been rotated. Save the new credentials below."
        : "Here are the details for your token";

    return (
        <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
                <Dialog.Content
                    className="
                        fixed left-1/2 top-1/2 z-50 
                        w-full max-w-sm sm:max-w-[620px] 
                        -translate-x-1/2 -translate-y-1/2
                        bg-grey-100 rounded-lg
                        shadow-dialog
                        border border-grey-80
                        p-4
                        !outline-none
                        max-h-[90vh] overflow-y-auto
                    "
                >
                    <div className="flex items-center border-b border-grey-80 mb-2 pb-0.5">
                        <Dialog.Close asChild>
                            <button
                                aria-label="Close"
                                className="absolute top-4 right-4 text-grey-10 hover:text-grey-20"
                            >
                                <CloseCircle className="size-6" />
                            </button>
                        </Dialog.Close>

                        <Dialog.Title className="text-grey-10 text-[22px] font-medium">
                            Token Details
                        </Dialog.Title>
                    </div>

                    <div className="mb-4">
                        <p className="text-lg font-medium text-grey-10">{title}</p>
                        <p className="text-base font-medium text-grey-70">
                            {subtitle}
                        </p>
                    </div>

                    <div className="space-y-4">
                        {/* Token Name */}
                        {token.name && (
                            <div>
                                <label className="block text-sm font-medium text-grey-70 mb-1">
                                    Token Name
                                </label>
                                <div className="text-base font-medium text-grey-20">
                                    {token.name}
                                </div>
                                <div className="mt-2 h-px bg-grey-80" />
                            </div>
                        )}

                        {/* Permissions - Only show for newly created tokens */}
                        {!isRotated && token.permission && (
                            <div>
                                <label className="block text-sm font-medium text-grey-70 mb-1">
                                    Permissions
                                </label>
                                <div className="text-base font-medium text-grey-20">
                                    {token.permission}
                                </div>
                                <div className="mt-2 h-px bg-grey-80" />
                            </div>
                        )}

                        {/* Access ID Key */}
                        {(token.accessKeyId || token.access_key_id) && (
                            <div>
                                <label className="block text-sm font-medium text-grey-70 mb-1">
                                    Access Key ID
                                </label>
                                <div className="flex items-center justify-between gap-x-4">
                                    <div className="flex-1 text-base font-medium text-grey-20 break-all">
                                        {token.accessKeyId || token.access_key_id}
                                    </div>
                                    <button
                                        onClick={() => handleCopy((token.accessKeyId || token.access_key_id)!, "Access Key ID")}
                                        className="flex-shrink-0 p-1.5 rounded duration-150"
                                    >
                                        {copiedField === "Access Key ID" ? (
                                            <Check className="size-5 text-success-50" />
                                        ) : (
                                            <Copy className="size-5 text-grey-50" />
                                        )}
                                    </button>
                                </div>
                                <div className="mt-2 h-px bg-grey-80" />
                            </div>
                        )}

                        {/* Secret Access Key */}
                        {(token.secretAccessKey || token.secret) && (
                            <div>
                                <label className="block text-sm font-medium text-grey-70 mb-1">
                                    Secret Access Key
                                </label>
                                <div className="flex items-center justify-between gap-x-4">
                                    <div className="flex-1 text-base font-medium text-grey-20 break-all">
                                        {token.secretAccessKey || token.secret}
                                    </div>
                                    <button
                                        onClick={() => handleCopy((token.secretAccessKey || token.secret)!, "Secret Access Key")}
                                        className="flex-shrink-0 p-1.5 rounded duration-150"
                                    >
                                        {copiedField === "Secret Access Key" ? (
                                            <Check className="size-5 text-success-50" />
                                        ) : (
                                            <Copy className="size-5 text-grey-50" />
                                        )}
                                    </button>
                                </div>
                                <div className="mt-2 h-px bg-grey-80" />
                            </div>
                        )}

                        {/* Expiry Date */}
                        {(token.expires_at || token.expiresAt) && (
                            <div>
                                <label className="block text-sm font-medium text-grey-70 mb-1">
                                    Expiry Date
                                </label>
                                <div className="text-base font-medium text-grey-20">
                                    {new Date(token.expires_at || token.expiresAt!).toLocaleString()}
                                </div>
                            </div>
                        )}

                        {/* Warning for rotated tokens */}
                        {isRotated && (
                            <div className="mt-4 p-3 bg-warning-100 border border-warning-80 rounded-lg">
                                <p className="text-sm font-medium text-warning-50 mb-2">⚠️ Important</p>
                                <ul className="text-sm text-grey-40 space-y-1">
                                    <li>• The new secret will <strong>not</strong> be displayed again</li>
                                    <li>• Save the secret securely before closing this dialog</li>
                                    <li>• Update any applications using the old secret</li>
                                </ul>
                            </div>
                        )}
                    </div>

                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
});

export default TokenDetailsDialog;

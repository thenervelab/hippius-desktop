"use client";

import React, { useState } from "react";
import { Copy } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Props = {
    accessKeyId: string;
    secret: string;
    showWarning?: boolean;
    warningTitle?: string;
    warningItems?: string[];
};

/**
 * Reusable component for displaying access key credentials
 * Follows DRY principle - used across multiple dialogs
 */
const TokenCredentialsDisplay = React.memo(function TokenCredentialsDisplay({
    accessKeyId,
    secret,
    showWarning = true,
    warningTitle = "⚠️ Important Information",
    warningItems = [
        "The secret access key will not be displayed again",
        "Save both credentials securely before closing this dialog",
        "You can rotate the token later to generate a new secret"
    ],
}: Props) {
    const [copiedSecret, setCopiedSecret] = useState(false);
    const [copiedAccessKey, setCopiedAccessKey] = useState(false);

    const handleCopySecret = () => {
        if (secret) {
            navigator.clipboard.writeText(secret);
            setCopiedSecret(true);
            toast.success("Secret copied to clipboard!");
            setTimeout(() => setCopiedSecret(false), 2000);
        }
    };

    const handleCopyAccessKey = () => {
        if (accessKeyId) {
            navigator.clipboard.writeText(accessKeyId);
            setCopiedAccessKey(true);
            toast.success("Access Key ID copied to clipboard!");
            setTimeout(() => setCopiedAccessKey(false), 2000);
        }
    };

    return (
        <div className="space-y-3">
            {/* Access Key ID */}
            <div className="bg-grey-100 border border-grey-90 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-grey-50 uppercase tracking-wide">
                        Access Key ID
                    </label>
                    <button
                        onClick={handleCopyAccessKey}
                        className={cn(
                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors text-xs font-medium",
                            copiedAccessKey
                                ? "bg-success-80 text-success-20"
                                : "bg-grey-90 text-grey-40 hover:bg-grey-80 hover:text-grey-20"
                        )}
                        title="Copy Access Key ID"
                    >
                        <Copy className="size-3.5" />
                        <span>{copiedAccessKey ? "Copied!" : "Copy"}</span>
                    </button>
                </div>
                <div className="bg-white border border-grey-80 rounded-md px-3 py-2.5 font-mono text-sm text-grey-10 break-all select-all">
                    {accessKeyId || "N/A"}
                </div>
            </div>

            {/* Secret Access Key */}
            <div className="bg-primary-100 border border-primary-90 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-primary-40 uppercase tracking-wide">
                        Secret Access Key
                    </label>
                    <button
                        onClick={handleCopySecret}
                        className={cn(
                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors text-xs font-medium",
                            copiedSecret
                                ? "bg-success-80 text-success-20"
                                : "bg-primary-50 text-white hover:bg-primary-40"
                        )}
                        title="Copy Secret"
                    >
                        <Copy className="size-3.5" />
                        <span>{copiedSecret ? "Copied!" : "Copy"}</span>
                    </button>
                </div>
                <div className="bg-white border border-primary-80 rounded-md px-3 py-2.5 font-mono text-sm text-grey-10 break-all select-all">
                    {secret || "N/A"}
                </div>
            </div>

            {/* Warning (Optional) */}
            {showWarning && (
                <div className="bg-warning-95 border border-warning-80 rounded-lg p-4">
                    <h4 className="text-sm font-semibold text-warning-40 mb-2">
                        {warningTitle}
                    </h4>
                    <ul className="text-sm text-grey-60 space-y-1 list-disc list-inside">
                        {warningItems.map((item, index) => (
                            <li key={index} dangerouslySetInnerHTML={{ __html: item }} />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
});

export default TokenCredentialsDisplay;

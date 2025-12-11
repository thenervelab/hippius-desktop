"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Graphsheet as GraphSheet } from "@/components/ui";
import { CloseCircle, HippiusLogo } from "@/components/ui/icons";
import TokenCredentialsDisplay from "./TokenCredentialsDisplay";

// Generic token data type that works for both master and sub tokens
interface TokenSecretData {
    access_key_id?: string;
    accessKeyId?: string;
    secret?: string;
    secret_access_key?: string;
}

type Props = {
    open: boolean;
    onClose: () => void;
    tokenData: TokenSecretData | null;
};

const TokenSecretDialog = React.memo(function TokenSecretDialog({
    open,
    onClose,
    tokenData,
}: Props) {
    const handleClose = () => {
        onClose();
    };

    if (!tokenData) return null;

    // Get access key id from either format
    const accessKeyId = tokenData.accessKeyId || tokenData.access_key_id || "";
    // Get secret from either format
    const secret = tokenData.secret || tokenData.secret_access_key || "";

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
                        New Token Secret
                    </Dialog.Title>

                    <div className="space-y-4">
                        <TokenCredentialsDisplay
                            accessKeyId={accessKeyId}
                            secret={secret}
                            showWarning={true}
                            warningTitle="⚠️ Important Information"
                            warningItems={[
                                "The new secret will <strong>not</strong> be displayed again",
                                "Save the secret securely before closing this dialog",
                                "Update any applications using the old secret"
                            ]}
                        />
                    </div>

                    <div className="mt-6">
                        <button
                            onClick={handleClose}
                            className="
                                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                                hover:bg-primary-40 transition
                            "
                        >
                            <div className="py-2.5 rounded border border-primary-40 text-lg">
                                I&apos;ve Saved My New Secret
                            </div>
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
});

export default TokenSecretDialog;

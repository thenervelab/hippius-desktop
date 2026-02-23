"use client";

import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import { formatBytes } from "@/lib/utils/formatBytes";
import { FolderSync } from "lucide-react";

export interface MigrationPromptDialogProps {
    open: boolean;
    onClose: () => void;
    onMigrate: () => void;
    onSkip: () => void;
    fileCount: number;
    totalSize: number;
}

const MigrationPromptDialog: React.FC<MigrationPromptDialogProps> = ({
    open,
    onClose,
    onMigrate,
    onSkip,
    fileCount,
    totalSize,
}) => {
    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[480px] h-fit">
                <Dialog.Title className="sr-only">Migration Required</Dialog.Title>

                <div className="px-4 py-6 flex flex-col gap-5">
                    <div className="flex flex-col items-center text-center gap-3">
                        <div className="size-14 flex justify-center items-center relative">
                            <Graphsheet
                                majorCell={{
                                    lineColor: [31, 80, 189, 1.0],
                                    lineWidth: 2,
                                    cellDim: 200,
                                }}
                                minorCell={{
                                    lineColor: [49, 103, 211, 1.0],
                                    lineWidth: 1,
                                    cellDim: 20,
                                }}
                                className="absolute w-full h-full duration-500 opacity-30 z-0"
                            />
                            <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                            <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                                <FolderSync className="size-5 text-white" />
                            </div>
                        </div>
                        <h2 className="text-xl font-semibold text-grey-10">Migration Required</h2>
                        <p className="text-sm text-grey-50 max-w-sm">
                            We&apos;ve upgraded our storage system for better performance and security.
                            Your existing files need to be migrated.
                        </p>
                    </div>

                    {/* File Stats Box */}
                    <div className="bg-grey-95 border border-grey-80 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="h-10 w-10 bg-primary-100 border border-primary-80 rounded-lg flex items-center justify-center">
                                    <Icons.FolderOpen className="size-5 text-primary-50" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-grey-10">Files Found</p>
                                    <p className="text-xs text-grey-50">Ready for migration</p>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="text-lg font-semibold text-grey-10">{fileCount} files</p>
                                <p className="text-xs text-grey-50">{formatBytes(totalSize)}</p>
                            </div>
                        </div>
                    </div>

                    {/* Warning */}
                    <div className="bg-warning-50/10 border border-warning-50/30 rounded-lg p-3">
                        <div className="flex items-start gap-2">
                            <Icons.OctagonAlert className="size-5 text-warning-50 flex-shrink-0 mt-0.5" />
                            <p className="text-xs text-grey-40">
                                Until migration is complete, file uploads will be temporarily disabled.
                            </p>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-col gap-3">
                        <CardButton
                            variant="dialog"
                            className="w-full h-12 text-base font-medium"
                            onClick={onMigrate}
                        >
                            <div className="flex items-center gap-2">
                                <Icons.DocumentDownload className="size-5" />
                                Migrate My Files
                            </div>
                        </CardButton>
                        <CardButton
                            variant="secondary"
                            className="w-full h-12 text-base font-medium border border-grey-80"
                            onClick={onSkip}
                        >
                            Start Fresh
                        </CardButton>
                    </div>

                    {/* Recommended badge */}
                    <p className="text-center text-xs text-grey-50">
                        <span className="inline-flex items-center gap-1">
                            <Icons.TickCircle className="size-3 text-primary-50" />
                            &quot;Migrate My Files&quot; is recommended
                        </span>
                    </p>
                </div>
            </DialogContainer>
        </Dialog.Root>
    );
};

export default MigrationPromptDialog;

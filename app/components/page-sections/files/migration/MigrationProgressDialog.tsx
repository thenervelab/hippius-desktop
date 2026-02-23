"use client";

import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons, ProgressBar } from "@/components/ui";

export interface MigrationFile {
    cid: string;
    name: string;
    size: number;
    status: "pending" | "migrating" | "completed" | "failed";
    error?: string;
}

export interface MigrationProgressDialogProps {
    open: boolean;
    onCancel: () => void;
    files: MigrationFile[];
    currentFileIndex: number;
    overallProgress: number;
    currentFileName: string;
    isCancelling?: boolean;
}

const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const MigrationProgressDialog: React.FC<MigrationProgressDialogProps> = ({
    open,
    onCancel,
    files,
    currentFileIndex,
    overallProgress,
    currentFileName,
    isCancelling = false,
}) => {
    const completedCount = files.filter((f) => f.status === "completed").length;
    const failedCount = files.filter((f) => f.status === "failed").length;
    const totalCount = files.length;

    return (
        <Dialog.Root open={open}>
            <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[500px] h-fit">
                <Dialog.Title className="sr-only">Migration Progress</Dialog.Title>

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
                                {isCancelling ? (
                                    <Icons.Loader className="size-6 text-white animate-spin" />
                                ) : (
                                    <Icons.HippiusLogo className="size-6 text-white" />
                                )}
                            </div>
                        </div>
                        <h2 className="text-xl font-semibold text-grey-10">
                            {isCancelling ? "Cancelling Migration..." : "Migrating Your Files"}
                        </h2>
                        <p className="text-sm text-grey-50 max-w-sm">
                            {isCancelling
                                ? "Please wait while we safely stop the migration process."
                                : "Please keep this window open. This may take several minutes."}
                        </p>
                    </div>

                    {/* Overall Progress */}
                    <div className="bg-grey-95 border border-grey-80 rounded-lg p-4">
                        <div className="flex justify-between items-center mb-2">
                            <span className="text-sm font-medium text-grey-30">Overall Progress</span>
                            <span className="text-sm font-medium text-primary-50">
                                {completedCount} / {totalCount} files
                            </span>
                        </div>
                        <ProgressBar value={overallProgress} className="h-2" />
                        <div className="flex justify-between items-center mt-2 text-xs text-grey-50">
                            <span>{Math.round(overallProgress)}% complete</span>
                            {failedCount > 0 && (
                                <span className="text-error-50">{failedCount} failed</span>
                            )}
                        </div>
                    </div>

                    {/* Current File */}
                    <div className="bg-grey-95 border border-grey-80 rounded-lg p-4">
                        <div className="flex items-center gap-3">
                            <div className="h-8 w-8 bg-primary-100 border border-primary-80 rounded-lg flex items-center justify-center flex-shrink-0">
                                <Icons.File className="size-4 text-primary-50" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-grey-20 truncate">
                                    {currentFileName || "Preparing..."}
                                </p>
                                <p className="text-xs text-grey-50">
                                    File {currentFileIndex + 1} of {totalCount}
                                </p>
                            </div>
                            <Icons.Loader className="size-5 text-primary-50 animate-spin flex-shrink-0" />
                        </div>
                    </div>

                    {/* File List (scrollable) */}
                    <div className="bg-grey-95 border border-grey-80 rounded-lg p-3 max-h-[200px] overflow-y-auto">
                        <p className="text-xs font-medium text-grey-50 mb-2 px-1">File Status</p>
                        <div className="space-y-1">
                            {files.map((file, index) => (
                                <div
                                    key={file.cid}
                                    className={`flex items-center gap-2 px-2 py-1.5 rounded ${index === currentFileIndex ? "bg-primary-50/10" : ""
                                        }`}
                                >
                                    {file.status === "completed" ? (
                                        <Icons.TickCircle className="size-4 text-success-50 flex-shrink-0" />
                                    ) : file.status === "failed" ? (
                                        <Icons.CloseCircle className="size-4 text-error-50 flex-shrink-0" />
                                    ) : file.status === "migrating" ? (
                                        <Icons.Loader className="size-4 text-primary-50 animate-spin flex-shrink-0" />
                                    ) : (
                                        <div className="size-4 rounded-full border border-grey-70 flex-shrink-0" />
                                    )}
                                    <span className="text-xs text-grey-40 truncate flex-1">{file.name}</span>
                                    <span className="text-xs text-grey-60">{formatBytes(file.size)}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Cancel Button */}
                    <CardButton
                        variant="secondary"
                        className="w-full h-12 text-base font-medium border border-grey-80"
                        onClick={onCancel}
                        disabled={isCancelling}
                    >
                        {isCancelling ? "Cancelling..." : "Cancel Migration"}
                    </CardButton>

                    {/* Warning */}
                    <p className="text-xs text-grey-60 text-center">
                        Cancelling will keep already migrated files. Remaining files will not be migrated.
                    </p>
                </div>
            </DialogContainer>
        </Dialog.Root>
    );
};

export default MigrationProgressDialog;

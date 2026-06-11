"use client";

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderSync } from "lucide-react";
import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { formatBytes } from "@/lib/utils/formatBytes";

export interface MigrationPromptDialogProps {
    open: boolean;
    onMigrate: (syncPath: string) => void;
    onSkip: () => void;
    fileCount: number;
    totalSize: number;
}

const MigrationPromptDialog: React.FC<MigrationPromptDialogProps> = ({
    open,
    onMigrate,
    onSkip,
    fileCount,
    totalSize,
}) => {
    const [syncPath, setSyncPath] = useState<string>("");

    useEffect(() => {
        if (!open) return;
        invoke<string>("get_default_migration_path")
            .then(setSyncPath)
            .catch(() => setSyncPath(""));
    }, [open]);

    const handleBrowse = async () => {
        const selected = await openDialog({
            directory: true,
            title: "Choose migration folder",
            defaultPath: syncPath || undefined,
        });
        if (selected) {
            setSyncPath(selected);
        }
    };

    return (
        // Migration is a required decision, so there is no silent dismiss:
        // the X / outside-click / Escape all route to onSkip, which opens
        // the type-DELETE skip-confirmation step rather than closing outright.
        <FramedDialog
            open={open}
            onClose={onSkip}
            title="Migration Required"
            icon={<FolderSync className="size-5 text-white" />}
            maxWidth="max-w-[640px]"
        >
            <p className="mb-5 text-center text-sm leading-5 text-grey-50 dark:text-grey-dark-700">
                We&apos;ve upgraded from S3 to Arion for better performance and
                security. Your existing files need to be migrated to continue using
                Hippius Drive.
            </p>

            {/* Files Found summary */}
            <div className="mb-4 flex items-center justify-between rounded-lg border border-grey-80 bg-grey-95/60 p-4 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
                <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary-50/10 dark:bg-primary-50/20">
                        <Icons.FolderOpen className="size-5 text-primary-50 dark:text-primary-40" />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-grey-10 dark:text-white">
                            Files Found
                        </p>
                        <p className="text-xs text-grey-50 dark:text-grey-dark-700">
                            Ready for migration
                        </p>
                    </div>
                </div>
                <div className="text-right">
                    <p className="text-lg font-semibold text-grey-10 dark:text-white">
                        {fileCount} files
                    </p>
                    <p className="text-xs text-grey-50 dark:text-grey-dark-700">
                        {formatBytes(totalSize)}
                    </p>
                </div>
            </div>

            {/* Upload-disabled warning */}
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning-50/40 bg-warning-50/10 p-3 dark:border-warning-50/35 dark:bg-warning-50/[0.12]">
                <Icons.OctagonAlert className="mt-0.5 size-5 shrink-0 text-warning-50" />
                <p className="text-xs leading-5 text-grey-40 dark:text-grey-dark-700">
                    Until migration is complete, file uploads will be temporarily
                    disabled.
                </p>
            </div>

            {/* Destination folder picker */}
            <div className="mb-5 flex flex-col gap-1.5">
                <label className="text-sm font-medium text-grey-30 dark:text-grey-dark-800">
                    Destination Folder
                </label>
                <div className="flex items-center gap-2">
                    <div className="flex h-11 min-w-0 flex-1 items-center rounded-lg border border-grey-80 bg-grey-95/60 px-3 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
                        <p
                            className="truncate text-sm text-grey-30 dark:text-grey-dark-800"
                            title={syncPath}
                        >
                            {syncPath || "Loading…"}
                        </p>
                    </div>
                    <Button
                        variant="defaultStable"
                        size="auto"
                        className="h-11 shrink-0 rounded-lg px-4 text-sm font-medium"
                        onClick={handleBrowse}
                    >
                        Browse
                    </Button>
                </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3">
                <Button
                    variant="primary"
                    size="auto"
                    className="h-12 w-full gap-2 rounded-md text-base font-medium"
                    onClick={() => onMigrate(syncPath)}
                    disabled={!syncPath}
                >
                    <Icons.DocumentDownload className="size-5" />
                    Migrate My Files
                </Button>
                <Button
                    variant="defaultStable"
                    size="auto"
                    className="h-12 w-full rounded-md text-base font-medium"
                    onClick={onSkip}
                >
                    Start Fresh
                </Button>
            </div>

            {/* Recommendation hint */}
            <p className="mt-4 text-center text-xs text-grey-50 dark:text-grey-dark-700">
                <span className="inline-flex items-center gap-1">
                    <Icons.TickCircle className="size-3.5 text-primary-50 dark:text-primary-40" />
                    &quot;Migrate My Files&quot; is recommended
                </span>
            </p>
        </FramedDialog>
    );
};

export default MigrationPromptDialog;

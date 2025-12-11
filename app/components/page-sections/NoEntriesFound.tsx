"use client";

import React from "react";
import { Icons } from "@/components/ui";
import Button from "@/components/ui/button/CardButton";
import { Loader2, Plus } from "lucide-react";

interface NoEntriesFoundProps {
    text: string;
    isLoading: boolean;
    callCreateObjectOrBucket: () => void;
    storageType: "bucket" | "object" | "token";
}

const NoEntriesFound: React.FC<NoEntriesFoundProps> = ({
    text,
    isLoading,
    callCreateObjectOrBucket,
    storageType,
}) => {
    const getDescription = () => {
        switch (storageType) {
            case "bucket":
                return "You currently do not have any S3 buckets. Create your first bucket to start storing objects.";
            case "object":
                return "This bucket is empty. Upload your first file to get started.";
            case "token":
                return "You currently do not have any API tokens. Create your first token to start managing programmatic access to your S3 buckets.";
            default:
                return "No entries found. Create one to get started.";
        }
    };

    return (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center bg-grey-100 rounded-lg border border-grey-80">
            <div className="size-16 rounded-full bg-primary-95 flex items-center justify-center mb-4">
                <Icons.DocumentText className="size-8 text-primary-50" />
            </div>
            <h3 className="text-lg font-medium text-grey-20 mb-2">No Entries Found</h3>
            <p className="text-sm text-grey-50 max-w-sm mb-6">{getDescription()}</p>
            <Button
                onClick={callCreateObjectOrBucket}
                disabled={isLoading}
                icon={
                    isLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Plus className="size-4" />
                    )
                }
                appendToStart
            >
                {text}
            </Button>
        </div>
    );
};

export default NoEntriesFound;

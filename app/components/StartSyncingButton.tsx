"use client";

import React from "react";
import { CardButton } from "@/components/ui";
import { cn } from "@/lib/utils";

interface StartSyncingButtonProps {
    className?: string;
    onClick?: () => void;
}

const StartSyncingButton: React.FC<StartSyncingButtonProps> = ({ className, onClick }) => {

    return (
        <CardButton
            className={cn("h-10 w-fit p-1", className)}
            onClick={onClick}
        >
            <div className="flex items-center gap-2 text-grey-100 text-base font-medium p-2">
                <span>Start Syncing</span>
            </div>
        </CardButton>
    );
};

export default StartSyncingButton;
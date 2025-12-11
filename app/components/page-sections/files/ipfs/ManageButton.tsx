import React, { FC } from "react";
import { Setting2 } from "@/components/ui/icons";

interface ManageButtonProps {
    text: string;
    isLoading: boolean;
    onClick: () => void;
    className?: string;
}

const ManageButton: FC<ManageButtonProps> = ({
    text,
    isLoading,
    onClick,
}) => {
    return (
        <button
            onClick={onClick}
            disabled={isLoading}
            className="flex items-center justify-between gap-1 h-9 px-2 py-2 bg-grey-100 text-sm font-meidum text-grey-10 border border-grey-80 rounded disabled:opacity-50 hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50 disabled:hover:bg-grey-100 disabled:hover:text-grey-10"
            title={text}
        >
            <Setting2 className="size-4" />
            <span className="ml-1">{text}</span>
        </button>
    );
};

export default ManageButton;

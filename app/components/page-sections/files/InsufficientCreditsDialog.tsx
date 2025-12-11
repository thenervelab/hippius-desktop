import React from "react";
import { useAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "./atoms/query-atoms";
import { Icons, CardButton, AbstractIconWrapper } from "@/components/ui";
import { openLinkByKey } from "@/app/lib/utils/links";

const InsufficientCreditsDialog: React.FC = () => {
    const [isOpen, setIsOpen] = useAtom(insufficientCreditsDialogOpenAtom);

    if (!isOpen) return null;
    const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) {
            setIsOpen(false);
        }
    };

    const handleOpenConsoleBillingPage = () => {
        setIsOpen(false)
        openLinkByKey("BILLING");
    }
    const handleOpenConsoleCreditsPage = () => {
        setIsOpen(false)
        openLinkByKey("CREDITS");
    }

    return (
        <div
            className="fixed inset-0 flex items-center justify-center z-50 bg-black/50"
            onClick={handleOverlayClick}
        >
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 animate-in fade-in">
                <div className="flex flex-col items-center">
                    <AbstractIconWrapper className="size-8 mb-4">
                        <Icons.BoxSimple2 className="relative size-5 text-primary-50" />
                    </AbstractIconWrapper>

                    <h2 className="text-2xl font-medium text-grey-10 text-center">
                        Insufficient Credits for File Upload
                    </h2>

                    <p className="mt-3 text-base text-center text-grey-50 mb-6">
                        You do not have enough credits to upload a file to Hippius. File upload is paused until your credits are enough.
                    </p>

                    <div className="flex flex-col w-full gap-y-2">
                        <CardButton
                            className="w-full"
                            onClick={handleOpenConsoleCreditsPage}
                        >
                            Buy Credits
                        </CardButton>

                        <CardButton
                            variant="secondary"
                            className="w-full"
                            onClick={handleOpenConsoleBillingPage}
                        >
                            Subscribe
                        </CardButton>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default InsufficientCreditsDialog;

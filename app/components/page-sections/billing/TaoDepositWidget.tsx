"use client";

import { FC } from "react";
import { TaoLogo, WalletAdd } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import useDepositAddress from "@/app/lib/hooks/useDepositAddress";
import { AbstractIconWrapper } from "../../ui";
import { CopyableCell } from "../../ui/alt-table";

const TaoDepositWidget: FC<{ className?: string }> = ({ className }) => {
    const { data: depositAddress } = useDepositAddress();

    return (
        <div
            className={cn(
                "w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between relative",
                className
            )}
        >
            <div className="flex flex-col w-full items-start">
                <div className="flex gap-4 items-center">
                    <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                        <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
                    </AbstractIconWrapper>
                    <span className="text-base font-medium text-grey-60">
                        Tao Deposit Address
                    </span>
                </div>
                <div className="w-full px-4 grow relative">
                    <div className="mt-6 space-y-4 mb-2">
                        <div className="grow flex flex-col items-center justify-center w-full">
                            <div className="flex bg-primary-50 items-center justify-center size-9 rounded">
                                <TaoLogo className="size-5 text-white" />
                            </div>
                        </div>
                        <div className="text-xs">
                            <span className="text-grey-70">Wallet Address - </span><span className="text-grey-10">SS58 Bittensor Chain</span>
                        </div>
                    </div>
                </div>
                <div className="relative bg-grey-100 w-full border-grey-80 border-t">
                    <div className="flex w-full border gap-x-2 border-grey-80 rounded items-center mt-4">
                        <CopyableCell
                            title="Copy Wallet Address"
                            toastMessage="Wallet Address Copied Successfully!"
                            copyAbleText={depositAddress ?? "---"}
                            textColor="text-grey-60 font-medium"
                            copyIconClassName="size-5 text-grey-60"
                            checkIconClassName="size-5"
                            className="p-2.5 w-full"
                            isTable={true}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TaoDepositWidget;

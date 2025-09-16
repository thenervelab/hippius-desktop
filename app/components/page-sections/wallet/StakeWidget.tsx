"use client";

import { FC } from "react";
import { useRouter } from "next/navigation";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";

const StakeWidget: FC = () => {
    const router = useRouter();

    const handleStakeNow = () => {
        router.push("/stake?tab=stake");
    };

    const handleUnstakeAlpha = () => {
        router.push("/unstake");
    };

    return (
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between h-[310px]">
            <div className="flex flex-col w-full items-start">
                <div className="flex gap-4 items-center">
                    <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                        <Icons.MoneyReceive className="absolute text-primary-40 size-4 sm:size-5" />
                    </AbstractIconWrapper>
                    <span className="text-base font-medium text-grey-60">
                        Stake hAlpha
                    </span>
                </div>
                <div className="flex justify-between items-end mt-4 w-full">
                    <div className="flex flex-col">
                        <div className="text-2xl font-medium text-grey-10">
                            0
                            <span className="text-xs font-medium -translate-y-1 ml-1">
                                hALPHA
                            </span>
                        </div>
                        <div className="text-xs text-grey-70 mt-2">
                            Total Staked Tokens
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex flex-col">
                <CardButton
                    className="w-full mt-4 h-[50px]"
                    onClick={handleStakeNow}
                >
                    <div className="flex items-center gap-2">
                        <Icons.MoneyReceive className="size-4" />
                        <span className="flex items-center text-lg font-medium">
                            Stake Now
                        </span>
                    </div>
                </CardButton>
                <CardButton
                    className="w-full mt-3 h-[50px]"
                    variant="secondary"
                    onClick={handleUnstakeAlpha}
                >
                    <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                        <Icons.MoneySend className="size-4" />
                        Unstake hAlpha
                    </div>
                </CardButton>
            </div>
        </div>
    );
};

export default StakeWidget;

"use client";

import { FC } from "react";
import { useRouter } from "next/navigation";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";

const BridgeWidget: FC = () => {
    const router = useRouter();

    const handleBridgeTokens = () => {
        router.push("/stake?tab=bridge");
    };

    return (
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between h-[310px]">
            <div className="flex flex-col w-full items-start">
                <div className="flex gap-4 items-center">
                    <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                        <Icons.Money className="absolute text-primary-40 size-4 sm:size-5" />
                    </AbstractIconWrapper>
                    <span className="text-base font-medium text-grey-60">
                        Bridge Tokens
                    </span>
                </div>
                <div className="flex justify-between items-end mt-4 w-full">
                    <div className="flex flex-col">
                        <div className="text-2xl font-medium text-grey-10">
                            Bridge tokens on Hippius
                        </div>
                        <div className="text-base font-medium text-grey-50 mt-2">
                            Transfer tokens between alpha and TAO easily on Hippius
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex flex-col">
                <CardButton
                    className="w-full mt-4 h-[50px]"
                    onClick={handleBridgeTokens}
                >
                    <div className="flex items-center gap-2">
                        <Icons.Money className="size-4" />
                        <span className="flex items-center text-lg font-medium">
                            Bridge Tokens
                        </span>
                    </div>
                </CardButton>
            </div>
        </div>
    );
};

export default BridgeWidget;

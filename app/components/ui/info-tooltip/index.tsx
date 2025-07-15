import React, { ReactNode } from "react";
import { Icons } from "@/components/ui";

interface InfoTooltipProps {
    children: ReactNode;
    className?: string;
    iconSize?: number | string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({
    children,
    className = "",
    iconSize = 4
}) => {
    return (
        <div className={`relative inline-block group overflow-visible ${className}`}>
            <div className="max-w-[245px]">
                <Icons.InfoCircle className={`size-${iconSize} text-grey-50 cursor-pointer`} />
            </div>
            <div className="
        absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2
        w-max max-w-[260px]
        bg-white border border-grey-80 rounded-[8px]
        px-2 py-2 text-[10px] font-medium text-grey-40 shadow-lg
        whitespace-normal break-words
        opacity-0 invisible group-hover:opacity-100 group-hover:visible
        transition-all duration-200 z-50
      ">
                {children}
                <div className="
          absolute bottom-[-8px] left-1/2 transform -translate-x-1/2
          w-0 h-0
          border-l-[8px] border-r-[8px] border-t-[8px]
          border-l-transparent border-r-transparent border-t-white
        "/>
            </div>
        </div>
    );
};

export default InfoTooltip;
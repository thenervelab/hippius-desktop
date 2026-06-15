import React from "react";
import { cn } from "@/lib/utils";

interface TemplateItemProps {
  label: string;
  value: React.ReactNode;
  className?: string;
}

const TemplateItem: React.FC<TemplateItemProps> = ({
  label,
  value,
  className,
}) => {
  return (
    <div className={cn("flex flex-1 min-w-0 flex-col gap-[8px]", className)}>
      <div className="text-[14px] font-medium leading-[22px] tracking-[-0.28px] text-grey-dark-800">
        {label}
      </div>
      <div className="truncate text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-black-700 dark:text-grey-light-300">
        {value}
      </div>
    </div>
  );
};

export default TemplateItem;

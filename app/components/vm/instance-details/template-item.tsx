import React from "react";
import { cn } from "@/lib/utils";

interface TemplateItemProps {
  label: string;
  value: string;
  className?: string;
}

const TemplateItem: React.FC<TemplateItemProps> = ({
  label,
  value,
  className,
}) => {
  return (
    <div className={cn("bg-[#F7F7F7] p-2 rounded", className)}>
      <div className="text-grey-50 font-medium text-base">{label}</div>
      <div className="text-grey-10 font-semibold text-base mt-2">{value}</div>
    </div>
  );
};

export default TemplateItem;

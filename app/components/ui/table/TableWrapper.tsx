import { cn } from "@/lib/utils";
import React, { ReactNode } from "react";

export const TableWrapper: React.FC<{ children: ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div
    className={cn(
      "relative flex overflow-x-auto overflow-y-auto rounded-[8px]",
      "border border-grey-dark-100 bg-white",
      "shadow-[0px_1px_0px_0px_white]",
      "custom-scrollbar-thin",
      "dark:border-black-900 dark:bg-black-500",
      "dark:shadow-[0px_1px_0px_0px_rgba(255,255,255,0.06)]",
      className,
    )}
  >
    <div className="w-0 grow">{children}</div>
  </div>
);

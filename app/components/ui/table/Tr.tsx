import React from "react";
import { cn } from "@/lib/utils";

export interface TrProps extends React.HTMLAttributes<HTMLTableRowElement> {
  rowHover?: boolean;
  transparent?: boolean;
  roundedHeader?: boolean;
}

export const TABLE_ROW_ACTIVE_CLASSNAME =
  "bg-[#f1f1f1] dark:bg-black-primary-bg/70";
export const TABLE_ROW_HOVER_CLASSNAME =
  "group/hoverable-row cursor-pointer hover:bg-[#f1f1f1] dark:hover:bg-black-primary-bg/70";

export const Tr: React.FC<TrProps> = ({
  children,
  className,
  rowHover,
  transparent,
  roundedHeader,
  ...rest
}) => (
  <tr
    className={cn(
      rowHover && TABLE_ROW_HOVER_CLASSNAME,
      transparent && "*:bg-transparent",
      roundedHeader && "group/rounded-header",
      className,
    )}
    {...rest}
  >
    {children}
  </tr>
);

export const TrSpacer = () => <tr className="h-2" />;

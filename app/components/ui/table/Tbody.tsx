import React from "react";
import { cn } from "@/lib/utils";

export const TBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  children,
  className,
  ...rest
}) => (
  <tbody
    className={cn(
      "[&>tr:last-child>td]:border-b-0 [&>tr:last-child>th]:border-b-0",
      className,
    )}
    {...rest}
  >
    {children}
  </tbody>
);

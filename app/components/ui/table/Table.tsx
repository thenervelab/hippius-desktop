import React from "react";
import { cn } from "@/lib/utils";

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  children,
  className,
  ...rest
}) => (
  <table
    className={cn(
      "w-full border-collapse whitespace-nowrap font-geist",
      "leading-[var(--table-line-height,16px)] tracking-[var(--table-letter-spacing,-0.24px)]",
      className,
    )}
    {...rest}
  >
    {children}
  </table>
);

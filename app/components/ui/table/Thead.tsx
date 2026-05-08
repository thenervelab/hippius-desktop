import React from "react";
import { cn } from "@/lib/utils";

export const THead: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  children,
  className,
  ...rest
}) => (
  <thead className={cn(className)} {...rest}>
    {children}
  </thead>
);

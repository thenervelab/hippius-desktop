"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { ticketCategoryLabel } from "./ticketCategories";

interface CategoryBadgeProps {
  category: string;
  className?: string;
}

const CategoryBadge: React.FC<CategoryBadgeProps> = ({
  category,
  className,
}) => {
  const label = ticketCategoryLabel(category);

  return (
    <span
      className={cn(
        "text-[12px] font-medium leading-[18px] tracking-[-0.24px]",
        "text-grey-10 dark:text-grey-dark-200",
        className
      )}
    >
      {label}
    </span>
  );
};

export default CategoryBadge;

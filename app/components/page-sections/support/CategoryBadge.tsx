"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { categories } from "./CreateTicketModal";

interface CategoryBadgeProps {
  category: string;
}

const CategoryBadge: React.FC<CategoryBadgeProps> = ({ category }) => {
  const categoryConfig = categories.find((c) => c.value === category);
  const label = categoryConfig?.label || category;

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-1 rounded text-xs font-medium border border-grey-80 bg-grey-90 text-grey-10"
      )}
    >
      {label}
    </span>
  );
};

export default CategoryBadge;

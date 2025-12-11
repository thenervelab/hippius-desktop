"use client";

import React from "react";
import { Icons } from "@/components/ui";
import { cn } from "@/app/lib/utils";

interface SearchInputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  inView?: boolean;
  disabled?: boolean;
}

export const FilterSearchInput: React.FC<SearchInputProps> = ({
  value = "",
  onChange,
  placeholder = "Search",
  className,
  inView = true,
  disabled = false,
}) => {
  return (
    <div
      className={cn(
        "relative opacity-0 translate-y-4 w-full duration-500 delay-200 group",
        inView && "opacity-100 translate-y-0",
        className
      )}
    >
      <span className="absolute inset-y-0 left-0 flex items-center pl-2 group-hover:text-grey-20 transition-colors">
        <Icons.Search className="w-4 h-4 text-grey-70 group-hover:text-grey-20 transition-colors" />
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="new-password"
        className="w-full  h-9 font-medium font-grotesk pl-8 pr-3 py-2 text-sm text-gray-700 placeholder-grey-70 border border-grey-80 rounded focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 hover:border-grey-70 transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
      />
    </div>
  );
};

export default FilterSearchInput;

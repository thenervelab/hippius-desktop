"use client";

import React, { useRef } from "react";
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

export const SearchInput: React.FC<SearchInputProps> = ({
  value = "",
  onChange,
  placeholder = "Search",
  className,
  inView = true,
  disabled = false,
}) => {
  // Matches the Figma pill search styling and exposes a clear button when populated.
  const inputRef = useRef<HTMLInputElement>(null);
  const hasValue = value.trim().length > 0;

  return (
    <div
      className={cn(
        "relative opacity-0 translate-y-4 w-full h-8 duration-500 delay-200",
        inView && "opacity-100 translate-y-0",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center w-full h-full rounded-[40px]",
          "bg-grey-light-700 dark:bg-black-400",
          "border-[0.951px] border-grey-dark-100 dark:border-black-300",
          "shadow-[inset_0px_0.773px_0px_0px_rgba(255,255,255,0.06)]",
          "transition-colors hover:border-grey-dark-200 dark:hover:border-black-200",
          "focus-within:ring-1 focus-within:ring-[#1111111f] dark:focus-within:ring-white/10",
          disabled && "opacity-70 cursor-not-allowed",
        )}
        onClick={() => {
          if (disabled) return;
          inputRef.current?.focus();
        }}
      >
        <span className="flex items-center pl-[8px] pointer-events-none">
          <Icons.Search className="size-[14px] text-black-900/30 dark:text-grey-dark-800" />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="new-password"
          className={cn(
            "min-w-0 flex-1 h-full bg-transparent",
            "pl-[6px] pr-[8px] py-[4px]",
            "font-sans font-medium text-[12px] leading-none tracking-[-0.12px]",
            "text-black-900 dark:text-grey-light-100",
            "placeholder:text-black-900/30 dark:placeholder:text-grey-dark-800",
            "outline-none",
          )}
        />
        {hasValue && !disabled && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onChange?.("");
              inputRef.current?.focus();
            }}
            className={cn(
              "mr-[6px] flex items-center justify-center size-[20px] rounded-full",
              "text-black-900/30 transition-colors hover:text-black-900/60",
              "dark:text-grey-dark-800 dark:hover:text-grey-light-100",
            )}
          >
            <Icons.Close className="size-3.5" />
          </button>
        )}
        {!hasValue && (
          <span
            className={cn(
              "mr-[6px] flex items-center justify-center size-[20px] rounded-full",
              "bg-white border border-[#ededed] text-black-600",
              "text-[10.5px] leading-[12px] font-medium",
              "dark:bg-[#515151] dark:border-transparent dark:text-grey-light-100",
            )}
          >
            /
          </span>
        )}
      </div>
    </div>
  );
};

export default SearchInput;

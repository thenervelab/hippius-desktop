"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/* Compact pill-style select used for time-range filters on stat cards.
 * Ported from hippius-web's HomepageChartSelect but written directly
 * against Radix so we don't need to also port web's higher-level
 * `Select` wrapper — the desktop already has its own Select variants
 * with a different API. */

export interface ChartSelectOption {
  value: string;
  label: string;
}

interface HomepageChartSelectProps {
  options: ChartSelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

const HomepageChartSelect: React.FC<HomepageChartSelectProps> = ({
  options,
  value,
  onValueChange,
  className,
}) => {
  const selected = options.find((o) => o.value === value);

  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        className={cn(
          "inline-flex h-[32px] w-fit min-w-[112px] shrink-0 items-center justify-between gap-[6px] rounded-[7px] border border-[#e0e0e0] bg-white px-[10px] py-[6px] font-geist-mono text-[14px] font-medium uppercase leading-5 tracking-[-0.28px] text-grey-10 shadow-[0px_4px_8px_rgba(0,0,0,0.04),0px_1px_2px_rgba(0,0,0,0.12)] outline-none transition-colors hover:border-[#cfcfcf] hover:bg-[#fafafa] focus-visible:ring-2 focus-visible:ring-primary-50 dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-white dark:shadow-[0px_0px_0px_1px_black] dark:hover:border-[#5a5a5a] dark:hover:bg-[#242424]",
          className,
        )}
      >
        <span className="truncate pr-[2px] text-[14px] font-medium leading-5 tracking-[-0.28px]">
          {selected?.label ?? value}
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-[14px] text-grey-10 dark:text-white" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={cn(
            "z-[100] min-w-[156px] overflow-hidden rounded-[7px] border border-[#e0e0e0] bg-white shadow-[0px_8px_24px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#1f1f1f] dark:shadow-[0px_0px_0px_1px_black]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                className="relative flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-[4px] py-2 pl-3 pr-2 font-geist-mono text-[14px] font-medium uppercase leading-5 tracking-[-0.28px] text-grey-10 outline-none transition-colors data-[highlighted]:bg-grey-light-400 data-[state=checked]:text-primary-50 dark:text-white dark:data-[highlighted]:bg-[rgba(255,255,255,0.05)] dark:data-[state=checked]:text-primary-brand-dark"
              >
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check className="size-[14px]" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
};

export default HomepageChartSelect;

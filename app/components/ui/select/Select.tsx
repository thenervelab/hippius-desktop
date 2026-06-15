"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Loader } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  emptyMessage?: string;
  /** Removes scroll buttons and outer shadow — use for compact/inline selects */
  minimal?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  itemClassName?: string;
  valueClassName?: string;
  ariaLabel?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

const inputShell =
  "flex w-full gap-2 overflow-hidden rounded-[8px] border border-grey-80 bg-white px-4 py-4 " +
  "shadow-[0px_0px_0px_4px_rgba(10,10,10,0.05)] transition-[border-color,box-shadow] duration-200 " +
  "focus-within:border-primary-50 focus-within:shadow-[0px_0px_0px_4px_rgba(49,103,221,0.12)] " +
  "dark:border-[#494949] dark:bg-[#1f1f1f] dark:shadow-[0px_0px_0px_4px_rgba(255,255,255,0.03)] " +
  "dark:focus-within:border-primary-65 dark:focus-within:shadow-[0px_0px_0px_4px_rgba(97,140,232,0.15)]";

const Select = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectProps
>(
  (
    {
      options,
      value,
      onValueChange,
      placeholder = "Select an option",
      disabled = false,
      isLoading = false,
      emptyMessage,
      minimal = false,
      className,
      triggerClassName,
      contentClassName,
      itemClassName,
      valueClassName,
      ariaLabel,
      "aria-invalid": ariaInvalid,
    },
    ref,
  ) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const isInvalid = ariaInvalid === true || ariaInvalid === "true";

    return (
      <div className={cn("w-full", className)}>
        <SelectPrimitive.Root
          value={value}
          onValueChange={onValueChange}
          disabled={disabled || isLoading}
          onOpenChange={setIsOpen}
        >
          <SelectPrimitive.Trigger
            ref={ref}
            aria-label={ariaLabel ?? placeholder}
            aria-invalid={ariaInvalid}
            className={cn(
              inputShell,
              "group min-h-[52px] sm:min-h-[54px] min-w-0 items-center justify-between text-left",
              "text-grey-dark-800 dark:text-white",
              "data-[placeholder]:text-grey-dark-800 dark:data-[placeholder]:text-[#7d7d7d]",
              "disabled:cursor-not-allowed disabled:opacity-60",
              isInvalid &&
                "border-error-70 shadow-[0px_0px_0px_4px_rgba(235,87,87,0.12)]",
              minimal &&
                "shadow-none dark:shadow-none focus-within:shadow-none dark:focus-within:shadow-none",
              triggerClassName,
            )}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left font-medium text-base leading-[22px] tracking-[-0.32px]",
                valueClassName,
              )}
            >
              <SelectPrimitive.Value placeholder={placeholder} />
            </span>

            <SelectPrimitive.Icon asChild>
              {isLoading ? (
                <Loader className="size-[14px] sm:size-5 shrink-0 animate-spin text-black-900 dark:text-[#7d7d7d]" />
              ) : (
                <ChevronDown
                  className={cn(
                    "size-[14px] sm:size-5 shrink-0 text-black-900 transition-transform duration-200 dark:text-[#7d7d7d]",
                    isOpen && "rotate-180",
                  )}
                />
              )}
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>

          <SelectPrimitive.Portal>
            <SelectPrimitive.Content
              position="popper"
              sideOffset={4}
              className={cn(
                "z-[60] overflow-hidden rounded-[8px] border border-grey-80 bg-white",
                "shadow-[0px_20px_50px_-20px_rgba(10,10,10,0.45)]",
                "dark:border-[#494949] dark:bg-[#1f1f1f]",
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                contentClassName,
              )}
            >
              <SelectPrimitive.ScrollUpButton
                className={cn(
                  "flex h-8 items-center justify-center bg-white text-grey-dark-800 dark:bg-[#1f1f1f] dark:text-[#7d7d7d]",
                  minimal && "hidden",
                )}
              >
                <ChevronDown className="size-4 rotate-180" />
              </SelectPrimitive.ScrollUpButton>

              <SelectPrimitive.Viewport
                className={cn(
                  "max-h-64 min-w-[var(--radix-select-trigger-width)] p-1",
                  minimal && "overflow-y-auto",
                )}
              >
                {isLoading ? (
                  <SelectPrimitive.Item
                    value="__loading__"
                    disabled
                    className="flex w-full items-center justify-center px-3 py-4 outline-none"
                  >
                    <SelectPrimitive.ItemText>
                      <Loader className="size-5 animate-spin text-grey-dark-800 dark:text-[#7d7d7d]" />
                    </SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                ) : options.length === 0 ? (
                  <SelectPrimitive.Item
                    value="__empty__"
                    disabled
                    className="flex w-full items-center justify-center px-3 py-4 text-sm text-grey-dark-800 outline-none dark:text-[#7d7d7d]"
                  >
                    <SelectPrimitive.ItemText>
                      {emptyMessage ?? "No options available"}
                    </SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                ) : (
                  options.map((option) => (
                    <SelectPrimitive.Item
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                      className={cn(
                        "flex w-full min-w-0 cursor-pointer select-none items-center rounded-[6px]",
                        "px-3 py-3",
                        "text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-dark-800 outline-none transition-colors",
                        "data-[highlighted]:bg-grey-90 data-[state=checked]:bg-grey-90 data-[state=checked]:text-grey-10",
                        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                        "dark:text-[#a3a3a3] dark:data-[highlighted]:bg-[#2c2c2c] dark:data-[state=checked]:bg-[#2c2c2c] dark:data-[state=checked]:text-white",
                        itemClassName,
                      )}
                    >
                      <div className="flex min-w-0 w-full flex-col">
                        <SelectPrimitive.ItemText>
                          {option.label}
                        </SelectPrimitive.ItemText>
                        {option.description && (
                          <span className="text-xs text-grey-60 dark:text-[#7d7d7d] font-mono tracking-normal leading-4 truncate">
                            {option.description}
                          </span>
                        )}
                      </div>
                    </SelectPrimitive.Item>
                  ))
                )}
              </SelectPrimitive.Viewport>

              <SelectPrimitive.ScrollDownButton
                className={cn(
                  "flex h-8 items-center justify-center bg-white text-grey-dark-800 dark:bg-[#1f1f1f] dark:text-[#7d7d7d]",
                  minimal && "hidden",
                )}
              >
                <ChevronDown className="size-4" />
              </SelectPrimitive.ScrollDownButton>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
      </div>
    );
  },
);

Select.displayName = "Select";
export { Select };

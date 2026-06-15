import React from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Icons } from "@/components/ui";
import { cn } from "@/app/lib/utils";

export type Option = {
  value: string;
  label: string;
  disabled?: boolean;
};

type RadixSelectProps = {
  options: Option[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  triggerClassName?: string;
  contentClassName?: string;
  className?: string;
};

const Select: React.FC<RadixSelectProps> = ({
  options,
  value,
  onValueChange,
  placeholder = "Select an option",
  label,
  triggerClassName = "",
  contentClassName = "",
  className = "",
}) => {
  const selectedOption = options.find((opt) => opt.value === value);
  const selectedLabel = selectedOption?.label;
  const displayLabel = selectedLabel
    ? selectedLabel.replace(/^Last (\d+ Days)$/i, "$1")
    : undefined;

  return (
    <div className={cn("inline-block relative", className)}>
      {label && (
        <label className="block mb-1 text-sm font-medium">{label}</label>
      )}
      <RadixSelect.Root
        value={value}
        onValueChange={onValueChange}
        defaultOpen={false}
      >
        <RadixSelect.Trigger
          className={cn(
            "flex justify-center cursor-pointer group items-center gap-2 p-2 h-9 text-sm font-medium font-grotesk border border-grey-80 rounded text-grey-10 bg-grey-100 focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 whitespace-nowrap",
            triggerClassName,
          )}
          aria-label={label}
        >
          <RadixSelect.Value placeholder={placeholder}>
            {displayLabel}
          </RadixSelect.Value>
          <RadixSelect.Icon className="h-4 w-4 text-grey-10 font-grotesk ">
            <Icons.ChevronDown className="transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            side="bottom"
            position="popper"
            sideOffset={4}
            avoidCollisions={true}
            className={cn(
              "mt-1 overflow-hidden rounded-md bg-white shadow-lg border border-grey-80 w-[6.875rem] z-[100]",
              "dark:bg-black-600 dark:border-black-300 dark:shadow-[0px_20px_50px_-20px_rgba(0,0,0,0.6)]",
              contentClassName,
            )}
          >
            <RadixSelect.ScrollUpButton className={cn(
              "flex items-center justify-center text-grey-50 rotate-180 bg-white border-b border-grey-80 py-1",
              "dark:bg-black-600 dark:border-black-300 dark:text-white/50",
            )}>
              <Icons.ChevronDown className="h-4 w-4" />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport className="py-1 max-h-80 overflow-auto min-w-[11.25rem]">
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <RadixSelect.Item
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.disabled}
                    className={cn(
                      "flex items-center p-2 text-[12px] cursor-pointer text-grey-10 hover:bg-grey-95 focus:bg-grey-95 data-[disabled]:opacity-50 transition-colors duration-150 focus:outline-none select-none data-[highlighted]:bg-grey-95",
                      "dark:text-white dark:hover:bg-black-300 dark:focus:bg-black-300 dark:data-[highlighted]:bg-black-300",
                      isSelected
                        ? "bg-grey-80 font-medium dark:bg-black-300"
                        : "bg-white dark:bg-transparent",
                    )}
                  >
                    <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  </RadixSelect.Item>
                );
              })}
            </RadixSelect.Viewport>
            <RadixSelect.ScrollDownButton className={cn(
              "flex items-center justify-center text-grey-50 bg-white border-t border-grey-80 py-1",
              "dark:bg-black-600 dark:border-black-300 dark:text-white/50",
            )}>
              <Icons.ChevronDown className="h-4 w-4" />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
};

export default Select;

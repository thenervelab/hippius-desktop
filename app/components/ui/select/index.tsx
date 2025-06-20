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
  return (
    <div className={cn("inline-block relative", className)}>
      {label && (
        <label className="block mb-1 text-sm font-medium">{label}</label>
      )}
      <RadixSelect.Root value={value} onValueChange={onValueChange} defaultOpen={false}>
        <RadixSelect.Trigger
          className={cn(
            "flex justify-center items-center gap-2 p-2 h-9 text-sm font-medium font-grotesk border border-grey-80 rounded text-grey-10 bg-grey-100 focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 whitespace-nowrap",
            triggerClassName
          )}
          aria-label={label}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon className="h-4 w-4 text-grey-10 font-grotesk">
            <Icons.ChevronDown />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            side="bottom"
            position="popper"
            sideOffset={0}
            avoidCollisions={false}
            className={cn(
              "mt-1 overflow-hidden rounded-md bg-white shadow-lg w-[--radix-select-trigger-width]",
              contentClassName
            )}
          >
            <RadixSelect.ScrollUpButton className="flex items-center justify-center text-grey-10 rotate-180 bg-gray-100">
              <Icons.ChevronDown className="h-4 w-4" />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport className="py-1 max-h-80 overflow-auto">
              {options.map((opt) => (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className="flex items-center p-2 text-sm cursor-pointer bg-grey-100 select-none focus:bg-grey-80 data-[disabled]:opacity-50 transition-colors duration-150 focus:outline-none"
                >
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="ml-auto">
                    <Icons.ChevronDown />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
            <RadixSelect.ScrollDownButton className="flex items-center justify-center bg-gray-100">
              <Icons.ChevronDown className="h-4 w-4" />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
};

export default Select;

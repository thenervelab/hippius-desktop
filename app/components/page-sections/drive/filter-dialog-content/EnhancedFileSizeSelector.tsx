"use client";

import React, { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Dialog from "@radix-ui/react-dialog";
import { Icons } from "@/components/ui";
import { Check, X } from "lucide-react";
import { FileSizeSelector } from "./FileSizeSelector";
import { cn } from "@/lib/utils";

const FILTER_PILL_TRIGGER_CLASSES = cn(
  "group inline-flex h-8 items-center gap-2 whitespace-nowrap",
  "rounded-[7px] border px-[8px] pr-[10px]",
  "bg-[#fefefe] border-[#e0e0e0]",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "text-[12px] font-medium font-mono uppercase tracking-[-0.24px] leading-[20px]",
  "text-black-700 transition-colors hover:bg-grey-light-700",
  "dark:bg-[rgba(255,255,255,0.02)] dark:border-black-300 dark:text-white",
  "dark:shadow-[0px_0px_0px_1px_rgba(0,0,0,1)] dark:hover:bg-black-500",
);

// Predefined file size options in bytes
// Using different approach: min/max ranges instead of single values
// Predefined file size options using SI units (1000-based), consistent with formatBytes
const fileSizeOptions = [
  { value: 1, label: "Small", description: "< 1 MB" },
  { value: 1_000_000, label: "Medium", description: "1 MB - 100 MB" },
  { value: 100_000_000, label: "Large", description: "100 MB - 1 GB" },
  { value: 1_000_000_000, label: "Very Large", description: "> 1 GB" },
  { value: -1, label: "Custom", description: "Filter Custom Size" },
];

interface EnhancedFileSizeSelectorProps {
  selectedSizes?: number[];
  onSizesSelect?: (sizes: number[]) => void;
}

const EnhancedFileSizeSelector: React.FC<EnhancedFileSizeSelectorProps> = ({
  selectedSizes = [],
  onSizesSelect,
}) => {
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false);
  const [customSize, setCustomSize] = useState(0);
  const [customUnit, setCustomUnit] = useState("GB");

  const handleSizeToggle = (size: number) => {
    if (size === -1) {
      // Handle custom size option
      setIsCustomDialogOpen(true);
      return;
    }

    const newSelectedSizes = selectedSizes.includes(size)
      ? selectedSizes.filter((s) => s !== size)
      : [...selectedSizes, size];
    onSizesSelect?.(newSelectedSizes);
  };

  const handleCustomSizeApply = () => {
    if (customSize > 0) {
      const newSelectedSizes = [
        ...selectedSizes.filter((s) => s >= 0),
        customSize,
      ]; // Remove any existing custom size and add new one
      onSizesSelect?.(newSelectedSizes);
    }
    setIsCustomDialogOpen(false);
  };

  const getDisplayText = () => {
    if (selectedSizes.length === 0) return "Size";
    if (selectedSizes.length === 1) {
      const size = selectedSizes[0];
      // Check if it's a predefined option
      const selectedOption = fileSizeOptions.find(
        (option) => option.value === size,
      );
      if (selectedOption && selectedOption.value !== -1) {
        return selectedOption.label;
      }
      // It's a custom size, format it nicely
      const formatCustomSize = (bytes: number) => {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }
        return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
      };
      return formatCustomSize(size);
    }
    // For multiple selections, show the labels separated by commas
    const labels = selectedSizes
      .map((size) => {
        const option = fileSizeOptions.find((option) => option.value === size);
        if (option && option.value !== -1) {
          return option.label;
        }
        // Format custom size
        const units = ["B", "KB", "MB", "GB", "TB"];
        let sizeValue = size;
        let unitIndex = 0;
        while (sizeValue >= 1024 && unitIndex < units.length - 1) {
          sizeValue /= 1024;
          unitIndex++;
        }
        return `${sizeValue.toFixed(sizeValue < 10 ? 1 : 0)} ${units[unitIndex]}`;
      })
      .filter(Boolean);

    if (labels.length <= 2) {
      return labels.join(", ");
    }
    return `${labels.length} sizes selected`;
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className={FILTER_PILL_TRIGGER_CLASSES}>
            <div className="text-black-700 dark:text-white">
              {getDisplayText()}
            </div>
            <Icons.ChevronDown className="size-4 text-black-700 transition-transform duration-200 group-data-[state=open]:rotate-180 dark:text-white" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={4}
            align="start"
            className="mt-1 bg-white border border-grey-80 rounded-lg px-2 py-1 shadow-menu min-w-[13.75rem] z-50 dark:bg-black-primary-bg dark:border-black-300"
          >
            {selectedSizes.length > 0 && (
              <>
                <DropdownMenu.Item
                  className="flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full dark:hover:bg-[#2a171b]"
                  onSelect={(e) => {
                    e.preventDefault();
                    onSizesSelect?.([]);
                  }}
                >
                  <div className="h-4 w-4 flex items-center justify-center">
                    <X className="h-3.5 w-3.5 text-red-500 dark:text-[#ff8b8b]" />
                  </div>
                  <span className="font-medium text-xs text-red-600 dark:text-[#ff8b8b]">
                    Clear All Sizes
                  </span>
                </DropdownMenu.Item>
                <div className="border-t border-grey-90 my-1 dark:border-black-300" />
              </>
            )}
            {fileSizeOptions.map((option) => (
              <DropdownMenu.Item
                key={option.value}
                className="group flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full dark:hover:bg-black-300/40"
                onSelect={(e) => {
                  e.preventDefault();
                  handleSizeToggle(option.value);
                }}
              >
                {option.value !== -1 ? (
                  <Checkbox.Root
                    className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors dark:border-black-300 dark:bg-black-500"
                    checked={selectedSizes.includes(option.value)}
                    onCheckedChange={() => handleSizeToggle(option.value)}
                  >
                    <Checkbox.Indicator>
                      <Check className="size-4 text-white" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                ) : (
                  <div className="h-5 w-5 flex items-center justify-center">
                    <Icons.Setting className="size-5 text-primary-50" />
                  </div>
                )}
                <div className="flex flex-col flex-1">
                  <span className="font-medium text-xs text-grey-40 dark:text-grey-light-100 dark:group-hover:text-white">
                    {option.label}
                  </span>
                  <span className="text-[11px] text-grey-50 dark:text-grey-dark-700">
                    {option.description}
                  </span>
                </div>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Custom Size Dialog */}
      <Dialog.Root
        open={isCustomDialogOpen}
        onOpenChange={setIsCustomDialogOpen}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 shadow-lg z-50 min-w-[25rem] dark:bg-black-primary-bg dark:border dark:border-black-300">
            <Dialog.Title className="text-lg font-semibold text-grey-10 mb-4 dark:text-white">
              Filter Custom Size
            </Dialog.Title>

            <div className="mb-6">
              <FileSizeSelector
                value={customSize}
                onValueChange={setCustomSize}
                onUnitChange={setCustomUnit}
                initialUnit={customUnit}
              />
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setIsCustomDialogOpen(false)}
                className="px-4 py-2 text-grey-50 hover:text-grey-30 transition-colors dark:text-grey-light-100 dark:hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleCustomSizeApply}
                className="px-4 py-2 bg-primary-50 text-white rounded hover:bg-primary-40 transition-colors"
              >
                Apply
              </button>
            </div>

            <Dialog.Close asChild>
              <button
                className="absolute top-3 right-3 text-grey-50 hover:text-grey-30 dark:text-grey-light-100 dark:hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
};

export default EnhancedFileSizeSelector;

"use client";

import React, { useState } from "react";
import * as Menubar from "@radix-ui/react-menubar";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Dialog from "@radix-ui/react-dialog";
import { Icons } from "@/components/ui";
import { Check, X } from "lucide-react";
import { FileSizeSelector } from "./FileSizeSelector";

// Predefined file size options in bytes
// Using different approach: min/max ranges instead of single values
const fileSizeOptions = [
    { value: 1, label: "Small", description: "< 1 MB" }, // 0 to 1MB
    { value: 1024 * 1024, label: "Medium", description: "1 MB - 100 MB" }, // 1MB to 100MB
    { value: 100 * 1024 * 1024, label: "Large", description: "100 MB - 1 GB" }, // 100MB to 1GB
    { value: 1024 * 1024 * 1024, label: "Very Large", description: "> 1 GB" }, // > 1GB
    { value: -1, label: "Custom", description: "Filter Custom Size" }, // Special value for custom
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
            const newSelectedSizes = [...selectedSizes.filter(s => s >= 0), customSize]; // Remove any existing custom size and add new one
            onSizesSelect?.(newSelectedSizes);
        }
        setIsCustomDialogOpen(false);
    };

    const getDisplayText = () => {
        if (selectedSizes.length === 0) return "Size";
        if (selectedSizes.length === 1) {
            const size = selectedSizes[0];
            // Check if it's a predefined option
            const selectedOption = fileSizeOptions.find((option) => option.value === size);
            if (selectedOption && selectedOption.value !== -1) {
                return selectedOption.label;
            }
            // It's a custom size, format it nicely
            const formatCustomSize = (bytes: number) => {
                const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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
            .map(size => {
                const option = fileSizeOptions.find((option) => option.value === size);
                if (option && option.value !== -1) {
                    return option.label;
                }
                // Format custom size
                const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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
            return labels.join(', ');
        }
        return `${labels.length} sizes selected`;
    };

    return (
        <>
            <Menubar.Root>
                <Menubar.Menu>
                    <Menubar.Trigger asChild>
                        <button className="flex justify-center group px-3 py-2 bg-grey-100 min-w-[112px] rounded border border-grey-80 hover:bg-grey-80 transition-colors">
                            <div className="text-sm font-medium text-grey-40 leading-5">
                                {getDisplayText()}
                            </div>
                            <Icons.ChevronDown className="ml-2 mt-0.5 size-4 text-grey-40 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                        </button>
                    </Menubar.Trigger>
                    <Menubar.Content className="mt-1 bg-grey-100 border border-grey-80 rounded-lg px-2 py-1 shadow-menu min-w-[220px] z-50">
                        {selectedSizes.length > 0 && (
                            <>
                                <Menubar.Item
                                    className="flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
                                    onSelect={(e) => {
                                        e.preventDefault();
                                        onSizesSelect?.([]);
                                    }}
                                >
                                    <div className="h-4 w-4 flex items-center justify-center">
                                        <X className="h-3.5 w-3.5 text-red-500" />
                                    </div>
                                    <span className="font-medium text-xs text-red-600">
                                        Clear All Sizes
                                    </span>
                                </Menubar.Item>
                                <div className="border-t border-grey-90 my-1" />
                            </>
                        )}
                        {fileSizeOptions.map((option) => (
                            <Menubar.Item
                                key={option.value}
                                className="flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
                                onSelect={(e) => {
                                    e.preventDefault();
                                    handleSizeToggle(option.value);
                                }}
                            >
                                {option.value !== -1 ? (
                                    <Checkbox.Root
                                        className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors"
                                        checked={selectedSizes.includes(option.value)}
                                        onCheckedChange={(checked) => {
                                            if (checked) {
                                                handleSizeToggle(option.value);
                                            } else {
                                                handleSizeToggle(option.value);
                                            }
                                        }}
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
                                    <span className="font-medium text-base text-grey-40">
                                        {option.label}
                                    </span>
                                    <span className="text-sm text-grey-50">
                                        {option.description}
                                    </span>
                                </div>
                            </Menubar.Item>
                        ))}
                    </Menubar.Content>
                </Menubar.Menu>
            </Menubar.Root>

            {/* Custom Size Dialog */}
            <Dialog.Root open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
                    <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-grey-100 rounded-lg p-6 shadow-lg z-50 min-w-[400px]">
                        <Dialog.Title className="text-lg font-semibold text-grey-10 mb-4">
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
                                className="px-4 py-2 text-grey-50 hover:text-grey-30 transition-colors"
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
                                className="absolute top-3 right-3 text-grey-50 hover:text-grey-30"
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
"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as Menubar from "@radix-ui/react-menubar";
import { cn } from "@/lib/utils";
import { UnitMenuItem } from "./UnitMenuItem";

// Unit conversion constants
const UNITS = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
} as const;

type Unit = keyof typeof UNITS;

const MAX_SIZE_BYTES = 10 * UNITS.TB; // 10TB in bytes

// Convert max size to different units for display
const getMaxForUnit = (unit: Unit) => {
  return MAX_SIZE_BYTES / UNITS[unit];
};

interface FileSizeSelectorProps {
  value?: number; // Value in bytes
  onValueChange?: (value: number) => void; // Callback with value in bytes
  className?: string;
}

export function FileSizeSelector({
  value = 0,
  onValueChange,
  className,
}: FileSizeSelectorProps) {
  const [inputValue, setInputValue] = React.useState("0");
  const [selectedUnit, setSelectedUnit] = React.useState<Unit>("GB");

  // Convert bytes to specific unit without changing the selected unit
  const bytesToCurrentUnit = React.useCallback((bytes: number, unit: Unit) => {
    if (bytes === 0) return "0";
    const converted = bytes / UNITS[unit];
    return converted.toFixed(2).replace(/\.?0+$/, "");
  }, []);

  // Convert display value to bytes
  const displayToBytes = React.useCallback(
    (displayValue: string, unit: Unit) => {
      const numValue = parseFloat(displayValue) || 0;
      const maxForUnit = getMaxForUnit(unit);
      const clampedValue = Math.min(numValue, maxForUnit);
      return Math.round(clampedValue * UNITS[unit]);
    },
    []
  );

  // Update input when value prop changes (but keep selected unit)
  React.useEffect(() => {
    const displayValue = bytesToCurrentUnit(value, selectedUnit);
    setInputValue(displayValue);
  }, [value, selectedUnit, bytesToCurrentUnit]);

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    if (newValue === "" || /^\d*\.?\d*$/.test(newValue)) {
      setInputValue(newValue);
      const bytes = displayToBytes(newValue, selectedUnit);
      onValueChange?.(bytes);
    }
  };

  // Handle unit change
  const handleUnitChange = (unit: Unit) => {
    // Convert current input value to the new unit
    const currentBytes = displayToBytes(inputValue, selectedUnit);
    const newDisplayValue = bytesToCurrentUnit(currentBytes, unit);

    setSelectedUnit(unit);
    setInputValue(newDisplayValue);
    onValueChange?.(currentBytes);
  };

  // Handle slider change
  const handleSliderChange = (values: number[]) => {
    const bytes = values[0];
    onValueChange?.(bytes);
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <label className="text-sm leading-5 text-grey-70 ">File Size</label>
        <div className="relative group">
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            placeholder="0"
            className="w-[140px] h-12 font-medium font-grotesk pl-3 pr-16 py-3 text-base text-grey-60 placeholder-grey-70 border border-grey-80 rounded-xl focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 hover:border-grey-70 transition-colors"
          />
          <div className="absolute right-0 top-1/2  h-full">
            <Menubar.Root>
              <Menubar.Menu>
                <Menubar.Trigger asChild>
                  <button className="flex items-center transform -translate-y-[46%] h-full py-1 px-2 text-base mr-2 font-medium text-grey-60 hover:text-grey-50 transition-colors  border-grey-80 hover:bg-grey-80 rounded">
                    <span>{selectedUnit}</span>
                  </button>
                </Menubar.Trigger>
                <Menubar.Content className="mt-1 bg-white border border-grey-80 rounded-lg p-1 shadow-menu min-w-[80px] z-50">
                  <UnitMenuItem
                    unit="KB"
                    onClick={() => handleUnitChange("KB")}
                  />
                  <UnitMenuItem
                    unit="MB"
                    onClick={() => handleUnitChange("MB")}
                  />
                  <UnitMenuItem
                    unit="GB"
                    onClick={() => handleUnitChange("GB")}
                  />
                  <UnitMenuItem
                    unit="TB"
                    onClick={() => handleUnitChange("TB")}
                  />
                </Menubar.Content>
              </Menubar.Menu>
            </Menubar.Root>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <SliderPrimitive.Root
          className="relative flex w-full touch-none select-none items-center"
          value={[value]}
          onValueChange={handleSliderChange}
          max={MAX_SIZE_BYTES}
          min={0}
          step={UNITS.MB} // 1MB steps for better UX
        >
          <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-grey-80">
            <SliderPrimitive.Range className="absolute h-full bg-primary-50" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="block h-[16px] w-[16px] rounded-full border border-primary-50 bg-primary-50 shadow-sm ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-50 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50" />
        </SliderPrimitive.Root>
      </div>
    </div>
  );
}

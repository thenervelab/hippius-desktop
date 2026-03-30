"use client";

import React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Loader } from "@/components/ui/icons";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from "@/components/ui/select/Select2";

type ImageSelectOption = {
  value: string;
  label: string;
  imageUrl?: string;
};

interface ImageOptionSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ImageSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
}
const FALLBACK_ICON =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2236%22%20height%3D%2236%22%20viewBox%3D%220%200%2036%2036%22%20fill%3D%22none%22%3E%0A%20%20%3Crect%20x%3D%226%22%20y%3D%226%22%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%227%22%20fill%3D%22%23F1F5F9%22%20stroke%3D%22%23CBD5E1%22%20stroke-width%3D%221%22%2F%3E%0A%20%20%3Crect%20x%3D%2210.5%22%20y%3D%2210.5%22%20width%3D%2215%22%20height%3D%2215%22%20rx%3D%224%22%20stroke%3D%22%2364748B%22%20stroke-opacity%3D%220.55%22%20stroke-width%3D%221.6%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M12.2%2022.6l4.2-4.2%203.2%203.2%202.2-2.2%204.2%204.2%22%20stroke%3D%22%23475569%22%20stroke-opacity%3D%220.88%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%0A%20%20%3Ccircle%20cx%3D%2214.8%22%20cy%3D%2215.6%22%20r%3D%221.5%22%20fill%3D%22%23475569%22%20fill-opacity%3D%220.88%22%2F%3E%0A%3C%2Fsvg%3E";

const ImageOptionSelect: React.FC<ImageOptionSelectProps> = ({
  value,
  onValueChange,
  options,
  placeholder = "Select option",
  disabled = false,
  isLoading = false,
}) => {
  const selectedOption = options.find((opt) => opt.value === value);
  const hasSelectedImage = Boolean(selectedOption?.imageUrl);

  // inside renderImage:
  const renderImage = (imageUrl?: string, label?: string) => (
    <div className="size-9 rounded bg-grey-90 flex items-center justify-center overflow-hidden shrink-0">
      <img
        src={imageUrl || FALLBACK_ICON}
        alt={label || "Option"}
        className="w-full h-full object-contain"
        onError={(e) => {
          // if the API link breaks, swap to fallback
          if (e.currentTarget.src !== FALLBACK_ICON) {
            e.currentTarget.src = FALLBACK_ICON;
          }
        }}
      />
    </div>
  );

  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger
        className="
          w-full flex items-center justify-between relative
          bg-grey-100 border border-grey-80 rounded-[0.5rem]
          px-4 py-3 text-base font-medium text-grey-60
          h-[3.5rem] focus:outline-none focus:border-grey-80
          disabled:opacity-50 disabled:cursor-not-allowed
        "
      >
        <div
          className={`flex items-center text-start self-start w-full ${
            hasSelectedImage ? "gap-3" : ""
          }`}
        >
          {hasSelectedImage
            ? renderImage(selectedOption?.imageUrl, selectedOption?.label)
            : null}
          <SelectValue placeholder={placeholder}>
            {selectedOption ? selectedOption.label : placeholder}
          </SelectValue>
        </div>
        {isLoading ? (
          <Loader className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 animate-spin" />
        ) : (
          <ChevronDown className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 pointer-events-none" />
        )}
      </SelectTrigger>

      <SelectContent
        className="
          mt-1 bg-grey-100 border border-grey-80 rounded-[0.5rem]
          shadow-lg max-h-60 overflow-auto z-50 p-0
        "
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="p-0">
          <SelectGroup>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="
                  relative flex items-center gap-3
                  px-4 py-3
                  text-base font-medium text-grey-60
                  cursor-pointer
                  rounded-none
                  outline-none
                  data-[highlighted]:bg-grey-90 data-[highlighted]:rounded
                  data-[selected]:bg-grey-90 data-[selected]:rounded
                "
              >
                {renderImage(option.imageUrl, option.label)}
                <SelectPrimitive.ItemText>
                  {option.label}
                </SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectGroup>
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectContent>
    </Select>
  );
};

export default ImageOptionSelect;

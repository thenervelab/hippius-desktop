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

  const renderImage = (imageUrl?: string, label?: string) => (
    <div className="size-9 rounded bg-grey-90 flex items-center justify-center overflow-hidden shrink-0">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={label || "Option"}
          className="w-full h-full object-contain"
        />
      ) : null}
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
          bg-grey-100 border border-grey-80 rounded-[8px]
          px-4 py-3 text-base font-medium text-grey-60
          h-[56px] focus:outline-none focus:border-grey-80
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
          mt-1 bg-grey-100 border border-grey-80 rounded-[8px]
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

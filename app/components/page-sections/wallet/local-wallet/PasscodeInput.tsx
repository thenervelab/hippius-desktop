"use client";

import React, { useState, useCallback } from "react";
import { cn } from "@/app/lib/utils";
import { Icons } from "@/components/ui";
import { Eye, EyeOff, AlertCircle } from "lucide-react";

interface PasscodeInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  onSubmit?: () => void;
}

const PasscodeInput: React.FC<PasscodeInputProps> = ({
  value,
  onChange,
  placeholder = "Enter your passcode",
  label,
  error,
  disabled = false,
  autoFocus = false,
  className,
  onSubmit,
}) => {
  const [showPasscode, setShowPasscode] = useState(false);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && onSubmit) {
        onSubmit();
      }
    },
    [onSubmit]
  );

  return (
    <div className={cn("flex flex-col gap-2 w-full", className)}>
      {label && (
        <label className="text-sm font-medium text-grey-60">{label}</label>
      )}
      <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
          <Icons.Key className="size-5" />
        </div>
        <input
          type={showPasscode ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn(
            "w-full h-14 pl-12 pr-12 border rounded-lg",
            "bg-transparent text-grey-10 text-base font-medium",
            "placeholder:text-grey-60",
            "outline-none transition-all duration-300",
            "hover:shadow-input-focus focus:shadow-input-focus",
            error ? "border-error-50" : "border-grey-80",
            disabled && "opacity-50 cursor-not-allowed"
          )}
        />
        <button
          type="button"
          onClick={() => setShowPasscode(!showPasscode)}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-grey-50 hover:text-grey-30 transition-colors"
          disabled={disabled}
          tabIndex={-1}
        >
          {showPasscode ? (
            <EyeOff className="size-5" />
          ) : (
            <Eye className="size-5" />
          )}
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
          <AlertCircle className="size-4" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

export default PasscodeInput;

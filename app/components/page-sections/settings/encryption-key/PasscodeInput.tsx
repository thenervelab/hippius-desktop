import React from "react";
import { Label } from "@/components/ui/label";

import { AlertCircle } from "lucide-react";
import { Icons, Input, RevealTextLine } from "@/components/ui";
import { Key, Eye, EyeOff } from "@/components/ui/icons";
import { cn } from "@/app/lib/utils";

interface PasscodeInputProps {
  passcode: string;
  onPasscodeChange: (value: string) => void;
  showPasscode: boolean;
  onToggleShowPasscode?: () => void;
  error?: string | null;
  label?: string;
  placeholder?: string;
  id?: string;
  inView: boolean;
  reveal?: boolean;
  className?: string;
  errorClassName?: string;
  copied?: boolean;
  copyToClipboard?: () => void;
  showCopy?: boolean;
}

const PasscodeInput: React.FC<PasscodeInputProps> = ({
  passcode,
  onPasscodeChange,
  showPasscode,
  onToggleShowPasscode,
  error,
  label = "Enter your Passcode to view your key",
  placeholder = "Enter your passcode here",
  id = "passcode",
  inView,
  reveal = true,
  className = "delay-300 w-full mt-8",
  errorClassName = "delay-400 w-full mt-2",
  copied = false,
  copyToClipboard,
  showCopy = false
}) => {
  return (
    <>
      <RevealTextLine
        rotate
        reveal={inView && reveal}
        parentClassName="w-full"
        className={className}
      >
        <div className="space-y-1 text-grey-10 w-full flex flex-col">
          <Label htmlFor={id} className="text-sm font-medium text-grey-70">
            {label}
          </Label>
          <div className="relative flex items-start w-full">
            <Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
            <Input
              id={id}
              placeholder={placeholder}
              type={showPasscode ? "text" : "password"}
              value={passcode}
              onChange={(e) => onPasscodeChange(e.target.value)}
              className="px-11 border-grey-80 h-14 text-grey-30 w-full
                bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-white"
            />

            {showCopy ? (
              copied ? (
                <div className="cursor-pointer" onClick={copyToClipboard}>
                  <Icons.Check
                    className={cn(
                      "size-6 text-green-500 absolute right-3 top-[28px] transform -translate-y-1/2"
                    )}
                  />
                </div>
              ) : (
                <div className="cursor-pointer" onClick={copyToClipboard}>
                  <Icons.Copy
                    className={cn(
                      "size-6 text-grey-60 hover:text-grey-70 absolute right-3 top-[28px] transform -translate-y-1/2"
                    )}
                  />
                </div>
              )
            ) : !showPasscode ? (
              <Eye
                type="button"
                onClick={onToggleShowPasscode}
                className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
              />
            ) : (
              <EyeOff
                type="button"
                onClick={onToggleShowPasscode}
                className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
              />
            )}
          </div>
        </div>
      </RevealTextLine>

      {error && (
        <RevealTextLine
          rotate
          reveal={inView && reveal}
          className={errorClassName}
        >
          <div className="flex text-error-70 text-sm font-medium items-center gap-2">
            <AlertCircle className="size-4 !relative" />
            <span>{error}</span>
          </div>
        </RevealTextLine>
      )}
    </>
  );
};

export default PasscodeInput;

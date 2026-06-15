import * as React from "react";

import { cn } from "@/lib/utils";

export const inputFieldShellClassName =
  "flex w-full gap-2 overflow-hidden rounded-[8px] border border-grey-80 bg-white px-4 py-4 shadow-[0px_0px_0px_4px_rgba(10,10,10,0.05)] transition-[border-color,box-shadow] duration-200 focus-within:border-primary-50 focus-within:shadow-[0px_0px_0px_4px_rgba(49,103,221,0.12)] dark:border-[#494949] dark:bg-[#1f1f1f] dark:shadow-[0px_0px_0px_4px_rgba(255,255,255,0.03)] dark:focus-within:border-primary-65 dark:focus-within:shadow-[0px_0px_0px_4px_rgba(97,140,232,0.15)]";

export const inputFieldControlClassName =
  "w-full flex-1 border-0 bg-transparent p-0 font-medium text-base leading-[22px] tracking-[-0.28px] text-grey-10 outline-none placeholder:text-grey-dark-800 disabled:cursor-not-allowed sm:tracking-[-0.32px] sm:placeholder:text-grey-dark-800/80 dark:text-white dark:placeholder:text-[#7d7d7d] sm:dark:placeholder:text-[#7d7d7d]/80";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  startAdornment?: React.ReactNode;
  endAdornment?: React.ReactNode;
  wrapperClassName?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      startAdornment,
      endAdornment,
      wrapperClassName,
      disabled,
      "aria-invalid": ariaInvalid,
      type,
      ...props
    },
    ref,
  ) => {
    const isInvalid = ariaInvalid === true || ariaInvalid === "true";

    return (
      <div
        className={cn(
          inputFieldShellClassName,
          "min-h-[54px] items-start sm:min-h-[54px] sm:items-center",
          disabled && "cursor-not-allowed opacity-60",
          isInvalid &&
            "border-error-70 shadow-[0px_0px_0px_4px_rgba(235,87,87,0.12)]",
          wrapperClassName,
        )}
      >
        {startAdornment ? (
          <span className="flex size-5 shrink-0 items-center justify-center text-grey-dark-800 sm:size-6 dark:text-[#7d7d7d]">
            {startAdornment}
          </span>
        ) : null}

        <input
          ref={ref}
          type={type}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          autoCapitalize="off"
          autoCorrect="off"
          className={cn(
            inputFieldControlClassName,
            "[appearance:textfield] [&::-ms-reveal]:hidden [&::-ms-clear]:hidden [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
            className,
          )}
          {...props}
        />

        {endAdornment ? (
          <div className="flex shrink-0 items-center justify-center text-grey-dark-800 dark:text-[#7d7d7d]">
            {endAdornment}
          </div>
        ) : null}
      </div>
    );
  },
);

Input.displayName = "Input";

export default Input;

export { Input };

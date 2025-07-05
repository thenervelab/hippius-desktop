import React, { ComponentProps, ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import classes from "./button.module.css";
import { Loader2 } from "lucide-react";

// Define types for our variants
type ButtonCardVariant = "primary" | "secondary" | "ghost" | "dialog" | "error";
type ButtonCardSize = "sm" | "md" | "lg";
type ButtonCardState = "disabled" | undefined;

// Type definition to replace VariantProps
interface ButtonCardVariantProps {
  variant?: ButtonCardVariant;
  size?: ButtonCardSize;
  state?: ButtonCardState;
  className?: string;
}

// Function to generate classes based on variants
const buttonCardVariants = ({
  variant = "primary",
  size,
  state,
  className,
}: ButtonCardVariantProps) => {
  const baseClasses =
    "rounded-[4px] py-3 px-4 w-[208px] min-w-fit font-medium duration-300 flex justify-center items-center gap-x-2";

  // Variant classes
  let variantClasses = "";
  switch (variant) {
    case "primary":
      variantClasses = cn(
        "relative overflow-hidden bg-primary-50 hover:bg-primary-40 text-white border border-primary-40 rounded shadow-outer-buttonCard",
        classes.primary
      );
      break;
    case "error":
      variantClasses = cn(
        "relative overflow-hidden bg-error-50 hover:bg-error-40 text-white border border-error-40 rounded shadow-outer-buttonCard",
        classes.error
      );
      break;
    case "secondary":
      variantClasses =
        "relative overflow-hidden bg-grey-100 hover:bg-grey-80 text-grey-10 border border-grey-80";
      break;
    case "ghost":
      variantClasses = "hover:opacity-60 text-grey-50";
      break;
    case "dialog":
      variantClasses = cn(
        "relative overflow-hidden bg-primary-50 hover:bg-primary-40 text-white border border-primary-40 rounded shadow-outer-buttonCard",
        classes.primary
      );
      break;
  }

  // Size classes
  let sizeClasses = "";
  switch (size) {
    case "sm":
      sizeClasses = "text-sm";
      break;
    case "md":
      sizeClasses = "text-base";
      break;
    case "lg":
      sizeClasses = "text-lg";
      break;
  }

  // State classes
  let stateClasses = "";
  if (state === "disabled") {
    stateClasses = "opacity-50 hover:opacity-50 cursor-not-allowed";
  }

  return cn(baseClasses, variantClasses, sizeClasses, stateClasses, className);
};

type CommonProps = {
  icon?: ReactNode;
  appendToStart?: boolean;
  disabled?: boolean;
};

interface ButtonCardProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonCardVariantProps,
    CommonProps {
  loading?: boolean;
  asLink?: false;
}

interface LinkProps
  extends ComponentProps<typeof Link>,
    ButtonCardVariantProps,
    CommonProps {
  asLink: true;
}

const ButtonCardOrLinkInner: React.FC<{
  children: React.ReactNode;
  variant: ButtonCardVariant;
  loading?: boolean;
  icon?: CommonProps["icon"];
  appendToStart?: boolean;
}> = ({ children, variant, icon, loading, appendToStart = false }) => {
  if (variant !== "ghost") {
    return (
      <>
        {variant === "primary" && (
          <div className="absolute border rounded border-primary-40 left-0.5 right-0.5 top-0.5 bottom-0.5 shadow-inner-buttonCard" />
        )}
        {variant === "dialog" && (
          <div className="absolute border rounded border-primary-40 left-1.5 right-1.5 top-1.5 bottom-1.5 shadow-inner-buttonCard" />
        )}
        {variant === "error" && (
          <div className="absolute border rounded border-error-70/80 left-1.5 right-1.5 top-1.5 bottom-1.5 shadow-inner-buttonCard shadow-md" />
        )}

        {appendToStart && icon && (
          <span className="size-4 relative">{icon}</span>
        )}

        {loading ? (
          <Loader2 className="animate-spin size-4" />
        ) : (
          <span className="relative">{children}</span>
        )}

        {!appendToStart && icon && (
          <span className="size-4 relative">{icon}</span>
        )}
      </>
    );
  }
  return children;
};

const ButtonCard = React.forwardRef<
  HTMLButtonElement,
  ButtonCardProps | LinkProps
>((props, ref) => {
  if (props.asLink) {
    const {
      className,
      variant = "primary",
      size,
      children,

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      asLink: _,
      icon,
      appendToStart,
      disabled,
      ...rest
    } = props;
    const state = disabled ? "disabled" : undefined;
    return (
      <Link
        className={buttonCardVariants({ variant, size, className, state })}
        {...rest}
      >
        <ButtonCardOrLinkInner
          icon={icon}
          variant={variant}
          appendToStart={appendToStart}
        >
          {children}
        </ButtonCardOrLinkInner>
      </Link>
    );
  } else {
    const {
      className,
      variant = "primary",
      size,
      children,
      loading,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      asLink: _,
      icon,
      disabled,
      appendToStart,
      ...rest
    } = props;
    const state = disabled ? "disabled" : undefined;
    return (
      <button
        ref={ref}
        className={buttonCardVariants({ variant, size, className, state })}
        {...rest}
      >
        <ButtonCardOrLinkInner
          icon={icon}
          variant={variant}
          loading={loading}
          appendToStart={appendToStart}
        >
          {children}
        </ButtonCardOrLinkInner>
      </button>
    );
  }
});
ButtonCard.displayName = "ButtonCard";

export default ButtonCard;

export { ButtonCard, buttonCardVariants };

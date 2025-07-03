import React, { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "cva";
import Link from "next/link";
import { Graphsheet } from "@/components/ui";

import { cn } from "@/app/lib/utils";
import classes from "./button.module.css";

const buttonVariants = cva({
  base: "rounded-[4px] py-3 px-4 w-[208px] min-w-fit font-medium duration-300 flex justify-center items-center gap-x-2",
  variants: {
    variant: {
      primary: cn(
        "relative overflow-hidden bg-primary-50 hover:bg-primary-50 text-white border border-primary-40 rounded",
        classes.primary
      ),
      error: cn(
        "relative overflow-hidden bg-error-50 hover:bg-error-40 text-white border border-error-40 rounded",
        classes.primary
      ),
      secondary:
        "relative overflow-hidden bg-grey-100 hover:bg-grey-80 text-grey-10 border border-grey-80",
      ghost: "hover:opacity-60 text-white",
    },
    size: {
      sm: "text-sm",
      md: "text-base py-2.5",
      lg: "text-lg",
    },
  },
  defaultVariants: {
    variant: "primary",
  },
});

type CommonProps = {
  icon?: ReactNode;
};

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants>,
    CommonProps {
  loading?: boolean;
  asLink?: false;
  childClass?: string;
}

interface LinkProps
  extends ComponentProps<typeof Link>,
    VariantProps<typeof buttonVariants>,
    CommonProps {
  asLink: true;
}

const ButtonOrLinkInner: React.FC<{
  children: React.ReactNode;
  variant: VariantProps<typeof buttonVariants>["variant"];
  loading?: boolean;
  icon?: CommonProps["icon"];
  childClass?: string;
}> = ({ children, variant, icon, childClass }) => {
  if (variant !== "ghost") {
    return (
      <>
        {variant === "primary" && (
          <div className="absolute border rounded border-primary-40 left-1.5 right-1.5 top-1.5 bottom-1.5" />
        )}
        {variant === "error" && (
          <div className="absolute border rounded border-error-40 left-1 right-1 top-1 bottom-1" />
        )}
        {variant === "secondary" && (
          <Graphsheet
            className="absolute opacity-40 left-0 top-0 w-full h-full"
            majorCell={{
              lineColor: [226, 226, 226, 1],
              lineWidth: 2,
              cellDim: 34,
            }}
            minorCell={{
              lineColor: [255, 255, 255, 1.0],
              lineWidth: 0,
              cellDim: 0,
            }}
          />
        )}
        <span className={cn("relative", childClass)}>{children}</span>

        {icon && <span className="size-4 relative">{icon}</span>}
      </>
    );
  }
  return children;
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps | LinkProps>(
  (props, ref) => {
    if (props.asLink) {
      const {
        className,
        variant = "primary",
        size,
        children,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        asLink: _,
        icon,
        ...rest
      } = props;

      return (
        <Link
          className={cn(buttonVariants({ variant, size, className }))}
          {...rest}
        >
          <ButtonOrLinkInner icon={icon} variant={variant}>
            {children}
          </ButtonOrLinkInner>
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
        childClass,
        ...rest
      } = props;
      return (
        <button
          ref={ref}
          className={cn(buttonVariants({ variant, size, className }))}
          {...rest}
        >
          <ButtonOrLinkInner
            icon={icon}
            variant={variant}
            loading={loading}
            childClass={childClass}
          >
            {children}
          </ButtonOrLinkInner>
        </button>
      );
    }
  }
);
Button.displayName = "Button";

export default Button;

export { Button, buttonVariants };

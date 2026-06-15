import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getDiagonalTextureSvgBackgroundImage } from "@/lib/ui-textures";

const CornerDots = ({
  dotSize = 4,
  dotColor,
  variant,
}: {
  dotSize?: number;
  dotColor?: React.CSSProperties["borderColor"];
  variant?:
    | "default"
    | "defaultStable"
    | "primary"
    | "primaryLight"
    | "destructive"
    | "warning"
    | null;
}) => {
  const offset = -(dotSize - 0.5);
  const style = (pos: React.CSSProperties): React.CSSProperties => ({
    width: dotSize,
    height: dotSize,
    ...(dotColor ? { borderColor: dotColor } : {}),
    ...pos,
  });

  const dotColorClassName = dotColor
    ? ""
    : variant === "primary" || variant === "primaryLight"
      ? "border-primary-50 dark:border-primary-50"
      : variant === "destructive"
        ? "border-[#fc7d73] dark:border-[#fc7d73]"
        : variant === "warning"
          ? "border-[#fbbd59] dark:border-[#fbbd59]"
          : "border-grey-dark-400 dark:border-grey-50";

  const borderWidthClassName =
    variant === "primary" || variant === "primaryLight"
      ? "border-[0.5px] dark:border-[1px]"
      : "border-[0.5px]";

  return (
    <>
      <span
        className={cn(
          "pointer-events-none absolute z-[2] bg-white opacity-0 group-hover:opacity-100 transition-opacity duration-200",
          borderWidthClassName,
          dotColorClassName,
        )}
        style={style({ top: offset, left: offset })}
      />
      <span
        className={cn(
          "pointer-events-none absolute z-[2] bg-white opacity-0 group-hover:opacity-100 transition-opacity duration-200",
          borderWidthClassName,
          dotColorClassName,
        )}
        style={style({ bottom: offset, left: offset })}
      />
      <span
        className={cn(
          "pointer-events-none absolute z-[2] bg-white opacity-0 group-hover:opacity-100 transition-opacity duration-200",
          borderWidthClassName,
          dotColorClassName,
        )}
        style={style({ bottom: offset, right: offset })}
      />
      <span
        className={cn(
          "pointer-events-none absolute z-[2] bg-white opacity-0 group-hover:opacity-100 transition-opacity duration-200",
          borderWidthClassName,
          dotColorClassName,
        )}
        style={style({ top: offset, right: offset })}
      />
    </>
  );
};

const ButtonTexture = ({
  color,
  opacity,
  size,
  lineWidth,
  className,
}: {
  color?: string;
  opacity?: number;
  size?: number;
  lineWidth?: number;
  className?: string;
}) => {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-[1] rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100",
        className,
      )}
      style={{
        backgroundImage: getDiagonalTextureSvgBackgroundImage({
          color,
          opacity,
          size,
          lineWidth,
        }),
      }}
    />
  );
};

const buttonVariants = cva(
  "font-geist group relative isolate overflow-visible inline-flex items-center justify-center whitespace-nowrap transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 cursor-pointer active:translate-y-[2px] active:scale-[0.98] active:shadow-none",
  {
    variants: {
      variant: {
        default:
          "bg-grey-90 text-grey-10 rounded hover:bg-[#D6D6D6] hover:rounded-[52px] dark:border dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#2e2e2e]",
        defaultStable:
          "bg-grey-90 text-grey-10 rounded-md hover:bg-[#D6D6D6] dark:border dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#2e2e2e]",
        primary:
          "bg-primary-50 text-white rounded-md hover:bg-[#2454c4] dark:hover:bg-[#2a5ad0]",
        warning: "bg-warning-200 text-white rounded-md hover:bg-warning-300 ",
        primaryLight:
          "border border-primary-50 bg-primary-50/[0.21] text-primary-50 rounded-[6px] hover:bg-primary-50/[0.25] dark:border-primary-brand-dark dark:bg-primary-65/[0.21] dark:text-primary-brand-dark dark:hover:bg-primary-50/[0.18]",
        destructive: "bg-[#fc7d73] hover:bg-[#fb695e] rounded-md",
        ghost: "bg-transparent",
      },
      size: {
        default: "font-medium text-lg tracking-[-0.36px] px-4",
        auto: "",
        sm: "h-9 px-3 text-sm rounded-md",
        icon: "h-10 w-10 p-0",
        noStyle: "p-0 h-auto",
      },
    },
    compoundVariants: [
      {
        variant: "ghost",
        class: "active:translate-y-0 active:scale-100",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type BaseProps = VariantProps<typeof buttonVariants> & {
  className?: string;
  children?: React.ReactNode;
  asChild?: boolean;
  dotSize?: number;
  dotColor?: React.CSSProperties["borderColor"];
  texture?: boolean;
  textureColor?: string;
  textureOpacity?: number;
  textureSize?: number;
  textureLineWidth?: number;
  textureClassName?: string;
  loading?: boolean;
};

type AsLinkProps = BaseProps & {
  asLink: true;
  href: string;
  target?: string;
  rel?: string;
};

type AsButtonProps = BaseProps & {
  asLink?: false;
  href?: never;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export type ButtonProps = AsLinkProps | AsButtonProps;

const Button = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps
>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      children,
      dotSize = 4,
      dotColor,
      texture = false,
      textureColor,
      textureOpacity,
      textureSize,
      textureLineWidth,
      textureClassName,
      loading = false,
      ...props
    },
    ref,
  ) => {
    const classes = cn(buttonVariants({ variant, size, className }));
    const showDots = variant !== "ghost";

    const decorations = (
      <>
        {showDots && texture ? (
          <ButtonTexture
            color={textureColor}
            opacity={textureOpacity}
            size={textureSize}
            lineWidth={textureLineWidth}
            className={textureClassName}
          />
        ) : null}
        {showDots ? (
          <CornerDots dotSize={dotSize} dotColor={dotColor} variant={variant} />
        ) : null}
      </>
    );

    const content = loading ? (
      <>
        <Loader2 className="animate-spin size-4 mr-2" aria-hidden="true" />
        {children}
      </>
    ) : (
      children
    );

    if ("asLink" in props && props.asLink) {
      const { asLink, href, target, rel, ...rest } = props as AsLinkProps;
      void asLink;
      return (
        <Link
          href={href}
          target={target}
          rel={rel}
          className={classes}
          ref={ref as React.Ref<HTMLAnchorElement>}
          aria-busy={loading || undefined}
          aria-disabled={loading || undefined}
          {...(rest as object)}
        >
          {decorations}
          {content}
        </Link>
      );
    }

    const { asLink, disabled, ...buttonProps } = props as AsButtonProps & {
      asLink?: false;
    };
    void asLink;
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={classes}
        ref={ref as React.Ref<HTMLButtonElement>}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...buttonProps}
      >
        {decorations}
        {content}
      </Comp>
    );
  },
);

Button.displayName = "Button";

export default Button;

export { Button, buttonVariants };

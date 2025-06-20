import { cn } from "@/app/lib/utils";
import { cva, type VariantProps } from "cva";
import { Ref } from "react";

const pVariants = cva({
  base: "font-medium",
  variants: {
    size: {
      xl: "text-lg md:text-xl lg:text-2xl",
      lg: "text-base md:text-lg lg:text-xl",
      md: "md:text-lg text-base",
      sm: "text-sm md:text-base",
      xs: "text-xs sm:text-sm",
      xxs: "text-xs",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

interface Props
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof pVariants> {
  ref?: Ref<HTMLHeadingElement>;
}

const P: React.FC<Props> = ({ className, size, ref, ...rest }) => (
  <p ref={ref} className={cn(pVariants({ size, className }))} {...rest} />
);

export default P;

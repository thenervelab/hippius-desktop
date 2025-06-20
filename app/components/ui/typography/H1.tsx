import { cn } from "@/app/lib/utils";
import { cva, type VariantProps } from "cva";
import { Ref } from "react";

const h1Variants = cva({
  base: "font-medium ",
  variants: {
    size: {
      lg: "text-[40px] leading-[48px] md:text-6xl lg:text-7xl 2xl:text-[82px]",
      md: "text-4xl md:text-6xl lg:text-7xl 2xl:text-[82px]",
      sm: "text-[2rem] lg:text-[3.5rem]",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

interface Props
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof h1Variants> {
  ref?: Ref<HTMLHeadingElement>;
}

const H1: React.FC<Props> = ({ className, size, ref, ...rest }) => (
  <h1 ref={ref} className={cn(h1Variants({ size, className }))} {...rest} />
);

export default H1;

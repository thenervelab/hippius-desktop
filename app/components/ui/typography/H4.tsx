import { cn } from "@/app/lib/utils";
import { cva, type VariantProps } from "cva";
import { Ref } from "react";

const h4Variants = cva({
  base: "font-medium font-grotesk",
  variants: {
    size: {
      md: "text-3xl lg:text-4xl",
      sm: "text-[22px] leading-[32px] lg:text-[32px] lg:leading-[40px]",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

interface Props
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof h4Variants> {
  ref?: Ref<HTMLHeadingElement>;
}

const H4: React.FC<Props> = ({ className, size, ref, ...rest }) => (
  <h4 ref={ref} className={cn(h4Variants({ size, className }))} {...rest} />
);

export default H4;

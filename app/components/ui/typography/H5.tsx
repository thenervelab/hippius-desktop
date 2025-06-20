import { cn } from "@/app/lib/utils";
import { cva, type VariantProps } from "cva";
import { Ref } from "react";

const h5Variants = cva({
  base: "font-medium font-grotesk",
  variants: {
    size: {
      md: "text-2xl lg:text-3xl",
      sm: "text-2xl lg:text-[28px] lg:leading-[36px]"
    }
  },
  defaultVariants: {
    size: "md"
  }
});

interface Props
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof h5Variants> {
  ref?: Ref<HTMLHeadingElement>;
}

const H5: React.FC<Props> = ({ className, size, ref, ...rest }) => (
  <h5 ref={ref} className={cn(h5Variants({ size, className }))} {...rest} />
);

export default H5;

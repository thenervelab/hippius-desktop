import { cn } from "@/app/lib/utils";
import { cva, type VariantProps } from "cva";
import { Ref } from "react";

const h5Variants = cva({
  base: "font-medium font-grotesk",
  variants: {
    size: {
      md: "text-2xl lg:text-3xl",
      sm: "text-2xl lg:text-[1.75rem] lg:leading-[2.25rem]"
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

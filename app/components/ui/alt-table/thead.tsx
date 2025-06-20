import { cn } from "@/lib/utils";

export type THeadProps = React.HTMLAttributes<HTMLTableSectionElement>;

export const THead: React.FC<THeadProps> = ({
  children,
  className,
  ...rest
}) => (
  <thead className={cn("bg-table-header", className)} {...rest}>
    {children}
  </thead>
);

import { cn } from "@/lib/utils";

export type THeadProps = React.HTMLAttributes<HTMLTableSectionElement>;

export const THead: React.FC<THeadProps> = ({
  children,
  className,
  ...rest
}) => (
  <thead className={cn("bg-table-header dark:bg-transparent", className)} {...rest}>
    {children}
  </thead>
);

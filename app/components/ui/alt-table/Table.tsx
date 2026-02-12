import { cn } from "@/lib/utils";

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  children,
  className,
  ...rest
}) => {
  return (
    <table className={cn("w-full whitespace-nowrap table-fixed", className)} {...rest}>
      {children}
    </table>
  );
};

import { cn } from "@/app/lib/utils";

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  children,
  className,
  ...rest
}) => {
  return (
    <table className={cn("min-w-full table-fixed border-collapse whitespace-nowrap", className)} {...rest}>
      {children}
    </table>
  );
};

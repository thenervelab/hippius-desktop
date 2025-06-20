import { cn } from "@/app/lib/utils";
import { ReactNode } from "react";

interface Props {
  children: ReactNode;
  className?: string;
}

export const TableWrapper: React.FC<Props> = ({ children, className }) => (
  <div className={cn("flex relative justify-center px-4 md:px-6", className)}>
    <div className="w-full max-w-content-max">{children}</div>
  </div>
);

export default TableWrapper;

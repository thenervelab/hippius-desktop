import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface Props {
  children: ReactNode;
  className?: string;
}

export const TableWrapper: React.FC<Props> = ({ children, className }) => (
  <div
    className={cn(
      "flex relative overflow-x-auto overflow-y-auto border border-grey-80 rounded custom-scrollbar-thin",
      className
    )}
  >
    <div className="w-0 grow">{children}</div>
  </div>
);

export default TableWrapper;

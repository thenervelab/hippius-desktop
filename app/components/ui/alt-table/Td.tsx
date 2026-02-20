import { cn } from "@/lib/utils";
import { Cell, flexRender } from "@tanstack/react-table";

export interface TdProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  cell: Cell<TData, TValue>;
  activeSortClassName?: string;
  columnWidth?: number;
}

export function Td<TData, TValue>(props: TdProps<TData, TValue>) {
  const { cell, className, activeSortClassName, columnWidth, ...rest } = props;

  const sortOrder = cell.column.getIsSorted();
  const canSort = cell.column.getCanSort();

  const style = columnWidth
    ? { ...props.style, width: `${columnWidth}%` }
    : props.style;

  return (
    <td
      className={cn(
        "font-medium px-4 py-3.5 border-x border-grey-80 text-grey-60 last:border-r-0 first:border-l-0",
        "",
        cell.column.id === "actions" && "w-10 p-0",
        (cell.column.id === "name" || cell.column.id === "wallet") && "max-w-0",
        className,
        canSort && sortOrder && activeSortClassName
      )}
      style={style}
      {...rest}
    >
      <div className={cn(
        "w-full",
        cell.column.id !== "actions" && cell.column.id !== "selection" && cell.column.id !== "wallet" && "truncate"
      )}>
        {flexRender(cell.column.columnDef.cell, cell.getContext())}
      </div>
    </td>
  );
}

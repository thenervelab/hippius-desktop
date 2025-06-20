import { cn } from "@/lib/utils";
import { Cell, flexRender } from "@tanstack/react-table";

export interface TdProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  cell: Cell<TData, TValue>;
  activeSortClassName?: string;
}

export function Td<TData, TValue>(props: TdProps<TData, TValue>) {
  const { cell, className, activeSortClassName, ...rest } = props;

  const sortOrder = cell.column.getIsSorted();
  const canSort = cell.column.getCanSort();

  return (
    <td
      className={cn(
        "font-medium px-4 py-3.5 border-x border-grey-80 text-grey-60 last:border-r-0 first:border-l-0",
        className,
        canSort && sortOrder && activeSortClassName
      )}
      {...rest}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </td>
  );
}

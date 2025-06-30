import { cn } from "@/lib/utils";
import { Header, flexRender } from "@tanstack/react-table";
import { ChevronDown } from "../icons";

export interface ThProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  header: Header<TData, TValue>;
  align?: "center" | "left" | "right";
  activeSortClassName?: string;
}

export function Th<TData, TValue>(props: ThProps<TData, TValue>) {
  const { onClick, header, className, activeSortClassName, align, ...rest } =
    props;
  const sortOrder = header.column.getIsSorted();
  const canSort = header.column.getCanSort();

  return (
    <th
      className={cn(
        "font-semibold text-sm px-4 border-x first:border-l-transparent last:border-r-transparent border-b py-3.5 text-grey-70",
        canSort && "pr-8",
        sortOrder && canSort && cn("text-primary-50", activeSortClassName),
        className
      )}
      onClick={(event) => {
        header.column.toggleSorting(
          sortOrder === "asc" || !sortOrder ? true : false
        );
        if (onClick) {
          onClick(event);
        }
      }}
      {...rest}
    >
      {/* <div className="absolute bottom-0 left-0 right-0 h-px bg-[#696969]" /> */}
      <div
        className={cn(
          "flex w-full",
          align === "center" && "justify-center",
          align === "left" && "justify-start",
          align === "right" && "justify-end"
        )}
      >
        {canSort ? (
          <button className="relative flex h-fit w-fit whitespace-nowrap uppercase">
            {flexRender(header.column.columnDef.header, header.getContext())}
            {sortOrder && (
              <ChevronDown
                className={cn(
                  "absolute mt-0.5 -right-5 w-4 duration-300",
                  sortOrder === "asc" && "rotate-180"
                )}
              />
            )}
          </button>
        ) : (
          <span className="uppercase">
            {flexRender(header.column.columnDef.header, header.getContext())}
          </span>
        )}
      </div>
    </th>
  );
}

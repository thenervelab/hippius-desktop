import { cn } from "@/lib/utils";
import { Header, flexRender } from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import React from "react";

export interface ThProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  header: Header<TData, TValue>;
  align?: "center" | "left" | "right";
  activeSortClassName?: string;
  columnWidth?: number; // percentage
  onResizeStart?: (columnId: string, startX: number) => void;
  preventSort?: boolean;
  /**
   * Hide the resize handle entirely — used by tables that don't want
   * user-resizable columns (e.g. the shares page, where rows are
   * narrow and resizing adds visual clutter without value).
   */
  disableResize?: boolean;
  /**
   * Skip the default `uppercase` text-transform on the header label.
   * Tables that match a Figma design with title-case column headers
   * (e.g. "Date Added") opt out via this prop so the rendered string
   * isn't force-uppercased.
   */
  disableUppercase?: boolean;
}

export function Th<TData, TValue>(props: ThProps<TData, TValue>) {
  const {
    onClick,
    header,
    className,
    activeSortClassName,
    align,
    columnWidth,
    onResizeStart,
    preventSort,
    disableResize,
    disableUppercase,
    ...rest
  } = props;

  const sortOrder = header.column.getIsSorted();
  const canSort = header.column.getCanSort();

  // Allow resizing all except an "actions" column (if you use one),
  // unless the consumer has explicitly disabled resize for this table.
  const canResize = !disableResize && header.id !== "actions";

  return (
    <th
      className={cn(
        "font-semibold text-xs px-2.5 border-x first:border-l-transparent last:border-r-transparent border-b py-3 text-grey-70 relative",
        canSort && "cursor-pointer hover:bg-gray-50/30",
        sortOrder && canSort && cn("text-primary-50", activeSortClassName),
        className,
      )}
      style={{
        width: columnWidth ? `${columnWidth}%` : undefined,
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".resize-handle")) {
          return; // ignore clicks on the resize handle
        }
        if (preventSort) return;
        if (canSort) {
          header.column.toggleSorting();
        }
        if (onClick) onClick(event);
      }}
      {...rest}
    >
      <div
        className={cn(
          "flex w-full",
          align === "center" && "justify-center",
          align === "left" && "justify-start",
          align === "right" && "justify-end",
        )}
      >
        {canSort ? (
          <button
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap",
              !disableUppercase &&
                header.column.columnDef.header !== "hALPHA EARNED" &&
                "uppercase",
            )}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
            <SortIndicator sortOrder={sortOrder} />
          </button>
        ) : (
          <span className={cn(!disableUppercase && "uppercase")}>
            {flexRender(header.column.columnDef.header, header.getContext())}
          </span>
        )}
      </div>

      {canResize && (
        <div
          className="resize-handle absolute top-0 right-0 h-full w-2 -mr-1 cursor-col-resize z-10 select-none"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation(); // avoid toggling sort
            onResizeStart?.(header.id, e.clientX);
          }}
        />
      )}
    </th>
  );
}

/**
 * Stacked up/down chevron pair used as the sort affordance on every
 * sortable column header.
 *
 * Same shape in all three states (unsorted / asc / desc) — only the
 * tint changes — so the visual paradigm stays consistent. Previously
 * the active state showed a single ChevronDown while the inactive
 * state showed `ArrowUpDown`, which read as "two different icons".
 *
 * - Unsorted: both chevrons dim (signals the column is sortable).
 * - Ascending: top chevron tinted primary, bottom dim.
 * - Descending: bottom chevron tinted primary, top dim.
 */
function SortIndicator({ sortOrder }: { sortOrder: false | "asc" | "desc" }) {
  const ascActive = sortOrder === "asc";
  const descActive = sortOrder === "desc";
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-col items-center leading-none shrink-0"
    >
      <ChevronUp
        className={cn(
          "size-3 -mb-[3px]",
          ascActive ? "text-primary-50" : "text-grey-70/40",
        )}
        strokeWidth={2.5}
      />
      <ChevronDown
        className={cn(
          "size-3",
          descActive ? "text-primary-50" : "text-grey-70/40",
        )}
        strokeWidth={2.5}
      />
    </span>
  );
}

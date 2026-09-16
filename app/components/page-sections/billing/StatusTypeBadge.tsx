import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import React from "react";

// Pill geometry (padding/gap/line-height/tracking) is font-relative (em),
// not px: WKWebView's pageZoom won't render fonts below a ~9px floor, so on
// zoom-out this 10px text stops shrinking while px geometry keeps scaling —
// the text ends up crammed edge-to-edge in a too-small pill. Em units
// resolve against the clamped font size, so the pill tracks the text at any
// zoom. At 100% the values are pixel-identical to the old px ones
// (0.6em=6px, 0.4em=4px, 1.6lh=16px, -0.02em=-0.2px).
const badgeVariants = cva(
  "flex px-[0.6em] py-0 justify-center items-center gap-[0.4em] rounded-[90px] w-fit overflow-hidden text-ellipsis font-medium text-[10px] leading-[1.6] tracking-[-0.02em]",
  {
    variants: {
      type: {
        // Red — failure states
        failed:    "bg-[rgba(255,109,97,0.30)] text-[#0A0A0A] dark:text-[#FC7D73]",
        error:     "bg-[rgba(255,109,97,0.30)] text-[#0A0A0A] dark:text-[#FC7D73]",
        declined:  "bg-[rgba(255,109,97,0.30)] text-[#0A0A0A] dark:text-[#FC7D73]",
        cancelled: "bg-[rgba(255,109,97,0.30)] text-[#0A0A0A] dark:text-[#FC7D73]",
        canceled:  "bg-[rgba(255,109,97,0.30)] text-[#0A0A0A] dark:text-[#FC7D73]",
        expired:   "bg-[rgba(255,109,97,0.30)] text-[#0A0A0A] dark:text-[#FC7D73]",
        // Yellow — warning/in-progress states
        pending:     "bg-[rgba(232,151,2,0.30)] text-[#0A0A0A] dark:text-[#FEB101]",
        processing:  "bg-[rgba(232,151,2,0.30)] text-[#0A0A0A] dark:text-[#FEB101]",
        in_progress: "bg-[rgba(232,151,2,0.30)] text-[#0A0A0A] dark:text-[#FEB101]",
        // Green — success states
        success:    "bg-[rgba(4,200,112,0.30)] text-[#0A0A0A] dark:text-[#04C870]",
        successful: "bg-[rgba(4,200,112,0.30)] text-[#0A0A0A] dark:text-[#04C870]",
        completed:  "bg-[rgba(4,200,112,0.30)] text-[#0A0A0A] dark:text-[#04C870]",
        paid:       "bg-[rgba(4,200,112,0.30)] text-[#0A0A0A] dark:text-[#04C870]",
        confirmed:  "bg-[rgba(4,200,112,0.30)] text-[#0A0A0A] dark:text-[#04C870]",
        // Grey — neutral/terminal states
        refunded: "bg-[rgba(156,163,175,0.30)] text-[#0A0A0A] dark:text-[#9ca3af]",
        reversed: "bg-[rgba(156,163,175,0.30)] text-[#0A0A0A] dark:text-[#9ca3af]",
      },
    },
  },
);

type StatusType = NonNullable<VariantProps<typeof badgeVariants>["type"]>;

/**
 * Every state this badge can draw, and the resolver for a raw API string.
 *
 * Exported because a caller keeping its OWN copy of the list is how a status
 * goes unrendered: the drive history held a narrower set that omitted
 * `completed`, `paid`, `confirmed`, `in_progress`, `refunded` and `reversed`,
 * so a successful charge resolved to null and its Status cell drew nothing.
 * Derive from here, or pass `fallback` so an unknown state still reads as
 * text rather than as an empty cell.
 */
export const STATUS_TYPES: ReadonlySet<string> = new Set([
  "failed",
  "error",
  "declined",
  "cancelled",
  "canceled",
  "expired",
  "pending",
  "processing",
  "in_progress",
  "success",
  "successful",
  "completed",
  "paid",
  "confirmed",
  "refunded",
  "reversed",
]);

export function toStatusType(raw: string | null | undefined): StatusType | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return STATUS_TYPES.has(key) ? (key as StatusType) : null;
}

interface Props {
  type: StatusType | null;
  fallback?: string;
  className?: string;
}

const StatusTypeBadge: React.FC<Props> = ({ type, fallback, className }) => {
  const label = type
    ? type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ")
    : fallback || "";

  if (!label) return null;

  return (
    <div
      className={cn(
        badgeVariants({ type }),
        !type && "bg-[rgba(156,163,175,0.30)] text-[#0A0A0A] dark:text-[#9ca3af]",
        className,
      )}
    >
      <span>{label}</span>
    </div>
  );
};

export default StatusTypeBadge;

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import React from "react";

const badgeVariants = cva(
  "py-1 px-2 flex gap-x-1 font-medium tracking-[-0.24px] rounded-[13px] items-center w-fit text-[length:var(--table-font-size,12px)] leading-normal",
  {
    variants: {
      type: {
        // Red — failure states
        failed:
          "bg-[rgba(252,125,115,0.15)] text-[#ff6d61] dark:bg-[rgba(252,125,115,0.2)] dark:text-[#ff6d61]",
        error:
          "bg-[rgba(252,125,115,0.15)] text-[#ff6d61] dark:bg-[rgba(252,125,115,0.2)] dark:text-[#ff6d61]",
        declined:
          "bg-[rgba(252,125,115,0.15)] text-[#ff6d61] dark:bg-[rgba(252,125,115,0.2)] dark:text-[#ff6d61]",
        cancelled:
          "bg-[rgba(252,125,115,0.15)] text-[#ff6d61] dark:bg-[rgba(252,125,115,0.2)] dark:text-[#ff6d61]",
        canceled:
          "bg-[rgba(252,125,115,0.15)] text-[#ff6d61] dark:bg-[rgba(252,125,115,0.2)] dark:text-[#ff6d61]",
        expired:
          "bg-[rgba(252,125,115,0.15)] text-[#ff6d61] dark:bg-[rgba(252,125,115,0.2)] dark:text-[#ff6d61]",
        // Green — success states
        success:
          "bg-[rgba(4,200,112,0.15)] text-[#04c870] dark:bg-[rgba(4,200,112,0.2)] dark:text-[#04c870]",
        successful:
          "bg-[rgba(4,200,112,0.15)] text-[#04c870] dark:bg-[rgba(4,200,112,0.2)] dark:text-[#04c870]",
        completed:
          "bg-[rgba(4,200,112,0.15)] text-[#04c870] dark:bg-[rgba(4,200,112,0.2)] dark:text-[#04c870]",
        paid: "bg-[rgba(4,200,112,0.15)] text-[#04c870] dark:bg-[rgba(4,200,112,0.2)] dark:text-[#04c870]",
        confirmed:
          "bg-[rgba(4,200,112,0.15)] text-[#04c870] dark:bg-[rgba(4,200,112,0.2)] dark:text-[#04c870]",
        // Blue — in-progress states
        pending:
          "bg-[rgba(49,103,221,0.15)] text-[#3167dd] dark:bg-[rgba(49,103,221,0.2)] dark:text-[#5b8af0]",
        processing:
          "bg-[rgba(49,103,221,0.15)] text-[#3167dd] dark:bg-[rgba(49,103,221,0.2)] dark:text-[#5b8af0]",
        in_progress:
          "bg-[rgba(49,103,221,0.15)] text-[#3167dd] dark:bg-[rgba(49,103,221,0.2)] dark:text-[#5b8af0]",
        // Grey — neutral/terminal states
        refunded:
          "bg-[rgba(156,163,175,0.15)] text-[#6b7280] dark:bg-[rgba(156,163,175,0.2)] dark:text-[#9ca3af]",
        reversed:
          "bg-[rgba(156,163,175,0.15)] text-[#6b7280] dark:bg-[rgba(156,163,175,0.2)] dark:text-[#9ca3af]",
      },
    },
  },
);

type StatusType = NonNullable<VariantProps<typeof badgeVariants>["type"]>;

interface Props {
  type: StatusType | null;
  fallback?: string;
  className?: string;
}

const StatusTypeBadge: React.FC<Props> = ({ type, fallback, className }) => {
  const label = type
    ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
    : fallback || "";

  if (!label) return null;

  return (
    <div
      className={cn(
        badgeVariants({ type }),
        !type &&
          "bg-[rgba(156,163,175,0.15)] text-[#6b7280] dark:bg-[rgba(156,163,175,0.2)] dark:text-[#9ca3af]",
        className,
      )}
    >
      <span>{label}</span>
    </div>
  );
};

export default StatusTypeBadge;

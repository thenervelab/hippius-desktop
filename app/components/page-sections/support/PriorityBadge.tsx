"use client";

import React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Priority pill — matches the Figma "Miner Pill" tokens (node 4045:155478):
 *   Medium  → bg #fff2cc, border #fec134, text #e89702 (warning-100/300)
 *   Low     → bg #f0f0f0, border #e4e4e4, text #8f8f8f (grey-light-800)
 *   High    → bg rgba(252,125,115,0.14), border rgba(252,125,115,0.59),
 *             text #fc7d73 (declined-100)
 * 20px tall, 8px horizontal padding, 90px radius, 10px Geist Medium with
 * -0.2px tracking. */
const badgeVariants = cva(
  "inline-flex h-[20px] items-center justify-center px-[8px] py-[4px] rounded-[90px] border w-fit overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[10px] leading-none tracking-[-0.2px]",
  {
    variants: {
      type: {
        low: "bg-[#f0f0f0] border-[#e4e4e4] text-[#8f8f8f] dark:bg-white/10 dark:border-white/15 dark:text-[#a3a3a3]",
        medium:
          "bg-[#fff2cc] border-[#fec134] text-[#e89702] dark:bg-[rgba(232,151,2,0.18)] dark:border-[rgba(232,151,2,0.5)] dark:text-[#FEB101]",
        normal:
          "bg-[#fff2cc] border-[#fec134] text-[#e89702] dark:bg-[rgba(232,151,2,0.18)] dark:border-[rgba(232,151,2,0.5)] dark:text-[#FEB101]",
        high: "bg-[rgba(252,125,115,0.14)] border-[rgba(252,125,115,0.59)] text-[#fc7d73] dark:bg-[rgba(252,125,115,0.18)] dark:border-[rgba(252,125,115,0.5)] dark:text-[#FC7D73]",
        urgent:
          "bg-[rgba(252,125,115,0.14)] border-[rgba(252,125,115,0.59)] text-[#fc7d73] dark:bg-[rgba(252,125,115,0.18)] dark:border-[rgba(252,125,115,0.5)] dark:text-[#FC7D73]",
      },
    },
  }
);

type PriorityType = NonNullable<VariantProps<typeof badgeVariants>["type"]>;

interface Props {
  priority: PriorityType | string | null | undefined;
  className?: string;
}

const VALID = new Set<PriorityType>([
  "low",
  "medium",
  "normal",
  "high",
  "urgent",
]);

const PriorityBadge: React.FC<Props> = ({ priority, className }) => {
  const normalized = String(priority ?? "")
    .toLowerCase()
    .trim();
  const variant = (VALID.has(normalized as PriorityType)
    ? (normalized as PriorityType)
    : null) as PriorityType | null;

  const label = normalized
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : "—";

  return (
    <div
      className={cn(
        badgeVariants({ type: variant }),
        !variant &&
          "bg-[#f0f0f0] border-[#e4e4e4] text-[#8f8f8f] dark:bg-white/10 dark:border-white/15 dark:text-[#a3a3a3]",
        className
      )}
    >
      <span>{label}</span>
    </div>
  );
};

export default PriorityBadge;

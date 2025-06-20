"use client";

import React from "react";
import { cn } from "@/app/lib/utils";

interface StatusPillProps {
  status: string;
  className?: string;
}

export const StatusPill: React.FC<StatusPillProps> = ({
  status,
  className,
}) => {
  const isOnline = status?.toLowerCase() === "online";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 px-2 py-1 rounded-lg",
        isOnline ? "bg-success-90" : "bg-grey-90",
        className
      )}
    >
      {/* Outer circle ring */}
      <span
        className={cn(
          "p-1 rounded-full",
          isOnline ? "bg-success-70" : "bg-grey-80"
        )}
      >
        {/* Inner dot */}
        <span
          className={cn(
            "block w-2 h-2 rounded-full",
            isOnline ? "bg-success-50" : "bg-grey-70"
          )}
        />
      </span>

      {/* Text */}
      <span className={cn("text-xs font-medium text-grey-10")}>
        {isOnline ? "Online" : "Offline"}
      </span>
    </span>
  );
};

export default StatusPill;

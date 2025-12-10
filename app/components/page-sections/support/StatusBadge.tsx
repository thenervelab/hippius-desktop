"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { PlusCircle, MinusCircle } from "lucide-react";

interface StatusBadgeProps {
  status: "open" | "closed" | "in_progress" | "resolved";
  textVersion?: boolean;
}

export default function StatusBadge({
  status,
  textVersion = false,
}: StatusBadgeProps) {
  const getStatusStyles = () => {
    switch (status) {
      case "open":
        return {
          container: "bg-grey-90 border-grey-80",
          icon: "text-grey-60",
          text: "text-grey-10",
          label: "Open",
          Icon: MinusCircle,
        };
      case "closed":
        return {
          container: "bg-green-50/10 border-green-500/20",
          icon: "text-green-600",
          text: "text-green-600",
          label: "Closed",
          Icon: PlusCircle,
        };
      case "resolved":
        return {
          container: "bg-green-50/10 border-green-500/20",
          icon: "text-green-600",
          text: "text-green-600",
          label: "Resolved",
          Icon: PlusCircle,
        };
      case "in_progress":
        return {
          container: "bg-blue-50/10 border-blue-500/20",
          icon: "text-blue-600",
          text: "text-blue-600",
          label: "In Progress",
          Icon: MinusCircle,
        };
      default:
        return {
          container: "bg-grey-90 border-grey-80",
          icon: "text-grey-60",
          text: "text-grey-10",
          label: status,
          Icon: MinusCircle,
        };
    }
  };

  const { container, icon, text, label, Icon } = getStatusStyles();

  return !textVersion ? (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3 py-2 rounded-lg border",
        container
      )}
    >
      <Icon className={cn("size-4", icon)} />
      <span className={cn("text-sm font-medium", text)}>{label}</span>
    </div>
  ) : (
    <div className="flex gap-2 items-center">
      <Icon className={cn("size-4", icon)} />
      <span className={cn("text-sm font-medium", text)}>{label}</span>
    </div>
  );
}

import React from "react";
import { cn } from "@/lib/utils";

export interface StatusCellProps {
  value: string;
  className?: string;
}

const StatusCell: React.FC<StatusCellProps> = ({ value, className }) => {
  const getStatusColor = () => {
    const normalizedStatus = value.toLowerCase();
    switch (normalizedStatus) {
      case "running":
        return "border-success-80 bg-success-40";
      case "connected":
        return "border-success-80 bg-success-40";
      case "stopped":
        return "border-warning-80 bg-warning-50";
      case "starting":
        return "bg-primary-90 bg-primary-70";
      case "stopping":
        return "border-[#E8CCFF] bg-[#BA66FF]";
      case "pending":
        return "border-grey-80 bg-grey-70";
      case "spawning":
        return "border-grey-80 bg-grey-70";
      case "failed":
        return "border-error-90 bg-error-50";
      case "error":
        return "border-error-90 bg-error-50";
      default:
        return "bg-grey-50";
    }
  };

  // Capitalize first letter for display
  const displayValue =
    value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className={cn("border-[3px] p-[3px] rounded-full", getStatusColor())}
      ></div>
      <span className="text-xs font-medium text-grey-10">{displayValue}</span>
    </div>
  );
};

export default StatusCell;

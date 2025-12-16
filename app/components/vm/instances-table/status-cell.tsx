import React from "react";
import { cn } from "@/lib/utils";

export interface StatusCellProps {
  value:
    | "Running"
    | "Connected"
    | "Stopped"
    | "Starting"
    | "Pending"
    | "Stopping"
    | "Failed";
  className?: string;
}

const StatusCell: React.FC<StatusCellProps> = ({ value, className }) => {
  const getStatusColor = () => {
    switch (value) {
      case "Running":
        return "border-success-80 bg-success-40";
      case "Connected":
        return "border-success-80 bg-success-40";
      case "Stopped":
        return "border-warning-80 bg-warning-50";
      case "Starting":
        return "bg-primary-90 bg-primary-70";
      case "Stopping":
        return "border-[#E8CCFF] bg-[#BA66FF]";
      case "Pending":
        return "border-grey-80 bg-grey-70";
      case "Failed":
        return "border-error-90 bg-error-70";
      default:
        return "bg-grey-50";
    }
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className={cn("border-[3px] p-[3px] rounded-full", getStatusColor())}
      ></div>
      <span className="text-xs font-medium text-grey-10">{value}</span>
    </div>
  );
};

export default StatusCell;

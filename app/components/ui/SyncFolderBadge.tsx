import { FC } from "react";
import { cn } from "@/lib/utils";

interface SyncFolderBadgeProps {
  label: string;
  className?: string;
}

const SyncFolderBadge: FC<SyncFolderBadgeProps> = ({ label, className }) => {
  if (!label) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium",
        "bg-primary-95 text-primary-40 border border-primary-80 flex-shrink-0",
        className
      )}
      title={`Sync folder: ${label}`}
    >
      {label}
    </span>
  );
};

export default SyncFolderBadge;

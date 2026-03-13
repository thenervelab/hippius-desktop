import { FC } from "react";
import { cn } from "@/lib/utils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";

interface SyncFolderBadgeProps {
  label: string;
  className?: string;
}

const SyncFolderBadge: FC<SyncFolderBadgeProps> = ({ label, className }) => {
  if (!label) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium max-w-[240px] align-middle",
        "bg-primary-95 text-primary-40 border border-primary-80",
        className
      )}
    >
      <MiddleTruncatedName name={label} className="text-[10px] font-medium" />
    </span>
  );
};

export default SyncFolderBadge;

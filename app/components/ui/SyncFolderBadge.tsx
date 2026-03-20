import { FC } from "react";
import { cn } from "@/lib/utils";
import { middleTruncate } from "@/lib/utils/middleTruncate";

interface SyncFolderBadgeProps {
  label: string;
  className?: string;
}

/** At text-[10px] with px-1.5 padding, ~36 chars fit comfortably. */
const BADGE_MAX_CHARS = 36;

const SyncFolderBadge: FC<SyncFolderBadgeProps> = ({ label, className }) => {
  if (!label) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 align-middle",
        "bg-primary-95 text-primary-40 border border-primary-80",
        className
      )}
      title={label}
    >
      {middleTruncate(label, BADGE_MAX_CHARS)}
    </span>
  );
};

export default SyncFolderBadge;

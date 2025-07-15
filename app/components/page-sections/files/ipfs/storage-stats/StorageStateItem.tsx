import { cn } from "@/lib/utils";
import { FC, ReactNode } from "react";

interface StorageStateItemProps {
  icon: ReactNode;
  value: string | number;
  label: string;
  className?: string;
}

const StorageStateItem: FC<StorageStateItemProps> = ({
  icon,
  value,
  label,
  className,
}) => {
  return (
    <div className={cn("flex items-center gap-x-2", className)}>
      <div className="text-primary-50">{icon}</div>
      <div className="flex items-center gap-x-1">
        <span className="text-sm font-medium text-grey-70">{label}</span>
        <span className="text-sm font-medium text-grey-10">{value}</span>
      </div>
    </div>
  );
};

export default StorageStateItem;

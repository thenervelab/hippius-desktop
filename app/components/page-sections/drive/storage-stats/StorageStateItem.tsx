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
    <div
      className={cn(
        "flex items-center gap-[2.354px] shrink-0",
        className,
      )}
    >
      <div className="text-primary-50 flex items-center">{icon}</div>
      <span className="font-sans text-[10px] font-medium leading-none tracking-[-0.2px] text-grey-50">
        {label}
      </span>
      <span className="font-sans text-[10px] font-medium leading-none tracking-[-0.2px] text-black-900 dark:text-grey-light-100">
        {value}
      </span>
    </div>
  );
};

export default StorageStateItem;

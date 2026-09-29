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
      {/* Match console StorageStateItem + Drive secondary labels: grey-50 is
          #4f4f4f and unreadable on dark without an explicit dark: grey. */}
      <div className="flex items-center text-[#1F50BD] dark:text-primary-brand-dark">
        {icon}
      </div>
      <span className="font-sans text-[10px] font-medium leading-none tracking-[-0.2px] text-grey-50 dark:text-[#c4c4c4]">
        {label}
      </span>
      <span className="font-sans text-[10px] font-medium leading-none tracking-[-0.2px] text-black-900 dark:text-grey-light-100">
        {value}
      </span>
    </div>
  );
};

export default StorageStateItem;

import { cn } from "@/lib/utils";
import { Loader, RefreshCcwDot } from "lucide-react";

const RefreshButton: React.FC<{
  onClick: () => void;
  refetching?: boolean;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
}> = ({ onClick, refetching, ariaLabel, className, iconClassName }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={refetching}
    aria-label={ariaLabel}
    className={cn(
      "flex h-8 w-[33px] items-center justify-center rounded-[7px] border",
      "bg-grey-light-700 border-grey-dark-100",
      "dark:bg-black-300 dark:border-black-300",
      "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
      "disabled:cursor-not-allowed",
      className,
    )}
  >
    {refetching ? (
      <Loader
        className={cn(
          "size-[18px] text-black-700 dark:text-white animate-spin",
          iconClassName,
        )}
      />
    ) : (
      <RefreshCcwDot
        className={cn(
          "size-[18px] text-black-700 dark:text-white opacity-40",
          iconClassName,
        )}
      />
    )}
  </button>
);

export default RefreshButton;

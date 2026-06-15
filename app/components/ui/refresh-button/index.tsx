"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader, RefreshCcwDot } from "lucide-react";

// A manual refresh is a local IPC that resolves in tens of ms, so driving the
// spinner purely off a parent `refetching` flag flashed it for a single frame
// and read as "no loading state". The button therefore owns a short click-spin:
// ANY click shows the spinner for a fixed minimum window, regardless of how
// fast the refresh resolves and independent of parent re-render timing. A
// parent-controlled `refetching` still forces the spin too (e.g. while a longer
// fetch is genuinely in flight).
const CLICK_SPIN_MS = 600;

const RefreshButton: React.FC<{
  onClick: () => void;
  refetching?: boolean;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
}> = ({ onClick, refetching, ariaLabel, className, iconClassName }) => {
  const [clickSpin, setClickSpin] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleClick = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setClickSpin(true);
    timerRef.current = setTimeout(() => setClickSpin(false), CLICK_SPIN_MS);
    onClick();
  };

  const spinning = clickSpin || Boolean(refetching);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={spinning}
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
      {spinning ? (
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
};

export default RefreshButton;

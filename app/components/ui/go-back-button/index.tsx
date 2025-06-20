"use client";
import React, { useCallback } from "react";
import { Icons } from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { useRouter } from "next/navigation";

interface GoBackButtonProps {
  href?: string;
  className?: string;
}

const GoBackButton: React.FC<GoBackButtonProps> = ({ href, className }) => {
  const { back } = useRouter();

  const handleClick = useCallback(() => {
    const hasHistory =
      typeof window !== "undefined" && window.history.length > 2;

    if (!hasHistory && href) {
      window.location.href = href;
    } else {
      back();
      if (href) {
        const currentPath = window.location.pathname;
        setTimeout(() => {
          if (window.location.pathname === currentPath) {
            window.location.href = href;
          }
        }, 100);
      }
    }
  }, [back, href]);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "bg-grey-90 group hover:opacity-70 duration-300 flex items-center w-fit p-1 md:p-2 gap-x-2 text-sm md:text-base rounded-lg text-grey-60",
        className
      )}
    >
      <Icons.ArrowRight className="origin-center duration-300 group-hover:-translate-x-1 *:stroke-1 rotate-180 size-6" />{" "}
      Back
    </button>
  );
};

export default GoBackButton;

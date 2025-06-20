"use client";

import React, { FC } from "react";
import { cn } from "@/app/lib/utils";

type RevealBulletLineProps = {
  reveal: boolean;
  delay?: number;
  children: React.ReactNode;
  className?: string;
};

const RevealBulletLine: FC<RevealBulletLineProps> = ({
  reveal,
  delay = 0,
  children,
  className = "",
}) => {
  return (
    <span
      className={cn(
        "group relative flex w-full items-center cursor-pointer transition-all duration-500 hover:cursor-pointer",
        reveal ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 -translate-y-1/2 block h-px w-4 bg-grey-90 origin-left transform scale-x-0 transition-transform duration-300 group-hover:scale-x-100 group-hover:bg-[#d0d0d0] group-hover:cursor-pointer"
        )}
      />

      <span
        className={cn(
          className,
          "no-underline relative z-10 transition-colors transition-transform duration-300 group-hover:translate-x-5 group-hover:text-[#d0d0d0] group-hover:cursor-pointer"
        )}
      >
        {children}
      </span>
    </span>
  );
};

export default RevealBulletLine;

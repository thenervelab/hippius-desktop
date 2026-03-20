"use client";

import React from "react";
import { Input, Icons } from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { InView } from "react-intersection-observer";

interface SearchBarProps {
  className?: string;
}

const SearchBar: React.FC<SearchBarProps> = ({ className }) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={cn(
            // container
            "flex items-center opacity-0 w-full min-w-[309px] h-[52px] duration-300",
            "p-2 border border-white rounded-lg bg-white/20",
            inView && "translate-y-0 opacity-100",
            className
          )}
        >
          {/* text input */}
          <Input
            type="text"
            placeholder="Search for Block, Txs, Node..."
            className="flex-grow bg-transparent border-0 shadow-none text-base font-normal text-white placeholder-white focus:outline-none focus:ring-0 px-0 min-w-0"
          />

          {/* “S” button */}
          <button className="flex items-center justify-center ml-4 px-2 py-2 border border-white rounded bg-white/30 text-base font-normal text-white transition focus:outline-none">
            <Icons.MagnifyGlass className="size-5 text-white" />
          </button>
        </div>
      )}
    </InView>
  );
};

export default SearchBar;

"use client";

import React, { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { CopyText } from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { fileTrackerUrl } from "@/lib/utils/arionContentHash";

/** Parts shown before "Show all". */
export const PARTS_PREVIEW = 3;

const shortHash = (hash: string) =>
  hash.length > 18 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;

/**
 * A file stored in parts: "<N> parts", then the first few part hashes, each
 * with copy and a File Tracker link, and "Show all" to list every part in
 * place with its own scroll.
 */
const ArionHashParts: React.FC<{ partHashes: string[] }> = ({ partHashes }) => {
  const [showAll, setShowAll] = useState(false);
  const count = partHashes.length;
  const shown = showAll ? partHashes : partHashes.slice(0, PARTS_PREVIEW);

  const openPart = async (hash: string) => {
    try {
      await openUrl(fileTrackerUrl(hash));
    } catch (err) {
      console.error("Failed to open File Tracker:", err);
    }
  };

  return (
    <div className="flex w-full flex-col gap-[6px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex shrink-0 items-center rounded-full bg-[#3167dd]/10 px-2 py-px text-[12px] font-medium leading-[18px] text-[#3167dd] dark:bg-[#618ce8]/15 dark:text-[#618ce8]">
          {count} parts
        </span>
        <span className="text-[12px] text-black-900/50 dark:text-white/50">
          spread across the Hippius network
        </span>
      </div>

      <ul
        aria-label="Arion Hash of each part"
        data-testid="arion-hash-parts"
        className={cn(
          "flex w-full flex-col rounded-[10px] bg-[#0000000F]",
          showAll && "max-h-[236px] overflow-y-auto",
        )}
      >
        {shown.map((hash, i) => (
          <li
            key={`${i}-${hash}`}
            className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-1 border-b border-black/5 py-1 pl-[10px] pr-1 last:border-b-0 dark:border-white/5"
          >
            <span className="text-[12px] tabular-nums text-black-900/50 dark:text-white/50">
              Part {i + 1}
            </span>
            <CopyText
              text={hash}
              title={`Copy part ${i + 1} hash`}
              toastMessage="Arion Hash Copied Successfully!"
              className="min-w-0"
              copyIconClassName="size-[14px]"
              checkIconClassName="size-[14px]"
            >
              <span
                title={hash}
                className="truncate font-mono text-[12px] text-grey-20 dark:text-white"
              >
                {shortHash(hash)}
              </span>
            </CopyText>
            <button
              type="button"
              onClick={() => void openPart(hash)}
              aria-label={`Open part ${i + 1} on File Tracker`}
              title="View on File Tracker"
              className="flex size-[24px] items-center justify-center rounded-[6px] text-[#3167dd] hover:bg-black/5 focus-visible:bg-black/5 focus-visible:outline-none dark:text-[#618ce8] dark:hover:bg-white/10 dark:focus-visible:bg-white/10"
            >
              <ArrowUpRight className="size-3.5" strokeWidth={2.25} />
            </button>
          </li>
        ))}
      </ul>

      {count > PARTS_PREVIEW ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="w-fit text-[14px] font-medium leading-none tracking-[-0.28px] text-[#3167dd] hover:underline focus-visible:underline focus-visible:outline-none dark:text-[#618ce8]"
        >
          {showAll ? "Show fewer" : `Show all ${count} parts`}
        </button>
      ) : null}
    </div>
  );
};

export default ArionHashParts;

"use client";

import { cn } from "@/lib/utils";

/**
 * Which cells start lit, column by column, top to bottom. Taken from the
 * design so the first frame is the one the designer drew; the animation
 * then breathes every cell on its own offset.
 */
const PATTERN = [
  "001000000",
  "000110101",
  "101001010",
  "001100000",
  "010000010",
  "110010001",
  "001011011",
  "000000000",
  "010000010",
  "001010000",
];

const COLS = PATTERN.length;
const ROWS = PATTERN[0].length;

/**
 * The 10×9 block of 6px squares that stands in for a spinner on the plan
 * flow dialogs. Lit cells and dim cells swap over time; each one is offset
 * by a fixed amount worked out from its position, so the motion is even but
 * never in step. Users who asked for reduced motion get the still pattern.
 */
export default function PixelGridLoader({
  tone = "primary",
  className,
}: {
  /** Primary while working, error when something went wrong. */
  tone?: "primary" | "error";
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex items-center gap-[3px]", className)}
    >
      {Array.from({ length: COLS }).map((_, col) => (
        <div key={col} className="flex h-[86px] w-1.5 flex-col justify-between">
          {Array.from({ length: ROWS }).map((__, row) => {
            const lit = PATTERN[col][row] === "1";
            // Spread the phases so neighbours are never in sync. Negative
            // delays start each cell mid-cycle; lit cells begin at the top
            // of theirs so the first frame matches the design.
            const phase = ((col * 7 + row * 13) % 9) / 9;
            const delay = -(lit ? phase * 0.5 : 0.9 + phase);
            return (
              <span
                key={row}
                className={cn(
                  "block size-1.5 animate-[pixel-twinkle_1.8s_ease-in-out_infinite] motion-reduce:animate-none",
                  tone === "error"
                    ? "bg-[#fc7d73]"
                    : "bg-primary-50 dark:bg-primary-65",
                  lit ? "opacity-100" : "opacity-20",
                )}
                style={{ animationDelay: `${delay.toFixed(2)}s` }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

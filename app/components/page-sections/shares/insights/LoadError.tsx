"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MUTED } from "./panelStyles";

/**
 * Something in the Insights panel that did not load: one calm line
 * (`loadErrorLine`) and Try again. The Comments tab and Link settings use it.
 */
export function LoadError({ line, onRetry }: { line: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2">
      <p className={cn("text-sm", MUTED)}>{line}</p>
      <Button variant="defaultStable" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

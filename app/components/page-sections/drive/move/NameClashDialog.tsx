"use client";

import React, { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import type { Clash, ClashAnswers } from "@/app/lib/drive-move/runMove";

/**
 * Asks, one clash at a time, what to do with an item whose name is
 * already taken at the destination: Keep both, Replace (files only, never
 * over a folder, and never into another drive: `noReplace`) or Skip. With more than one clash, "Do this for all"
 * answers the rest with the same choice. Closing the dialog skips what is
 * left.
 */
export default function NameClashDialog({
  request,
  onDone,
}: {
  request: { clashes: Clash[]; destinationName: string; noReplace?: boolean } | null;
  onDone: (answers: ClashAnswers | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ClashAnswers>(new Map());
  const [forAll, setForAll] = useState(false);

  useEffect(() => {
    setIndex(0);
    setAnswers(new Map());
    setForAll(false);
  }, [request]);

  const clash = request?.clashes[index] ?? null;
  const remaining = request ? request.clashes.length - index : 0;
  const canReplace = clash && !request?.noReplace ? !clash.item.isFolder && !clash.takenByFolder : false;

  const answer = (choice: "keepBoth" | "replace" | "skip") => {
    if (!request || !clash) return;
    const next = new Map(answers);
    const rest = forAll ? request.clashes.slice(index) : [clash];
    for (const c of rest) {
      // Replace never applies to a folder, so "for all" skips those.
      const fits = choice !== "replace" || (!c.item.isFolder && !c.takenByFolder);
      next.set(c.item.path, fits ? choice : "skip");
    }
    const nextIndex = forAll ? request.clashes.length : index + 1;
    if (nextIndex >= request.clashes.length) {
      onDone(next);
      return;
    }
    setAnswers(next);
    setIndex(nextIndex);
  };

  return (
    <FramedDialog
      open={Boolean(clash)}
      onClose={() => onDone(answers.size > 0 ? answers : null)}
      title={
        clash ? (
          <span className="block truncate">
            &ldquo;{clash.item.name}&rdquo; is already in {request?.destinationName}
          </span>
        ) : (
          ""
        )
      }
      icon={<Copy className="size-4 text-white" aria-hidden />}
      maxWidth="max-w-[440px]"
    >
      <div className="flex flex-col gap-4">
        {remaining > 1 && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-grey-50 dark:text-grey-dark-600">
            <input
              type="checkbox"
              checked={forAll}
              onChange={(e) => setForAll(e.target.checked)}
              className="size-4 accent-primary-50"
            />
            Do this for all {remaining}
          </label>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={() => answer("skip")}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Skip
          </Button>
          {canReplace && (
            <Button
              variant="defaultStable"
              size="auto"
              onClick={() => answer("replace")}
              className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
            >
              Replace
            </Button>
          )}
          <Button
            variant="primary"
            size="auto"
            autoFocus
            onClick={() => answer("keepBoth")}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Keep both
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}

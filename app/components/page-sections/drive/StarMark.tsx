"use client";

// The small filled star after a starred item's name, beside its link and
// sharing marks. In the normal text colour (not yellow): it says "starred",
// it does not ask to be looked at. Renders nothing for an item that is not.

import React from "react";
import { Star } from "lucide-react";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { starLabelOf } from "@/app/lib/starred/starState";
import { useStars } from "@/app/lib/starred/useStars";
import { cn } from "@/lib/utils";

/** The mark itself, for a surface that already knows the item is starred. */
export function StarredGlyph({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Starred"
      title="Starred"
      className={cn("inline-flex shrink-0 items-center text-grey-30 dark:text-grey-light-300", className)}
    >
      <Star className="size-3" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

/** A file or folder row's mark. `basePath` is the folder the surface shows. */
export function StarMark({
  file,
  basePath,
  className,
}: {
  file: FormattedUserFile;
  basePath?: string | null;
  className?: string;
}) {
  const { isStarred } = useStars([starLabelOf(file)]);
  if (!isStarred(file, basePath)) return null;
  return <StarredGlyph className={className} />;
}

/** A drive row's mark, by the label the drive is listed under. */
export function DriveStarMark({ label, className }: { label: string; className?: string }) {
  const { isDriveStarred } = useStars([label]);
  if (!isDriveStarred(label)) return null;
  return <StarredGlyph className={className} />;
}

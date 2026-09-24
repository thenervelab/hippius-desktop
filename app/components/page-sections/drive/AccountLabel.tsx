"use client";

import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import { accountLabelView } from "@/app/lib/shared-drives/accountLabel";
import { cn } from "@/lib/utils";

/**
 * One account, named the same way on every shared-drive surface.
 *
 * Shows the display name when the server sent one, otherwise the shortened
 * ss58 in mono. Hovering always reveals the full ss58 (the identity; a name
 * is not unique) and the email when this reader may see it. Used by the
 * members panel, the remove confirmation, Shared with me, the invite list,
 * the Added by column and File Details, so they cannot disagree about what
 * someone is called.
 */
export default function AccountLabel({
  ss58,
  name,
  email,
  maxChars = 22,
  className,
  prefix,
}: {
  ss58: string;
  name?: string | null;
  email?: string | null;
  maxChars?: number;
  className?: string;
  /** Words before the label inside the same hover target, e.g. "by ". */
  prefix?: string;
}) {
  const view = accountLabelView(ss58, name, email, maxChars);
  return (
    <CustomTooltip2
      side="bottom"
      className="min-w-0 max-w-full"
      tooltipContent={
        <span className="flex flex-col gap-0.5">
          {view.isName ? <span className="font-medium">{view.label}</span> : null}
          <span className="break-all font-mono text-xs">{view.ss58}</span>
          {view.email ? <span className="break-all text-xs">{view.email}</span> : null}
        </span>
      }
    >
      <span
        data-ss58={view.ss58}
        className={cn(
          "block min-w-0 cursor-default truncate",
          !view.isName && "font-mono",
          className,
        )}
      >
        {prefix}
        {view.label}
      </span>
    </CustomTooltip2>
  );
}

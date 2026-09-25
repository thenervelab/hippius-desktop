"use client";

import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import MiddleTruncate from "@/components/ui/MiddleTruncate";
import { accountLabelView } from "@/app/lib/shared-drives/accountLabel";
import { cn } from "@/lib/utils";

/**
 * One account, named the same way on every shared-drive surface.
 *
 * Shows the display name when the server sent one, otherwise the ss58 in
 * mono, either one shortened in the MIDDLE to the width the row gives it
 * (`MiddleTruncate`), never cut at the end. Hovering always reveals the full
 * ss58 (the identity; a name is not unique) and the email when this reader
 * may see it. Used by the
 * members panel, the remove confirmation, Shared with me, the invite list,
 * the Added by column and File Details, so they cannot disagree about what
 * someone is called.
 */
export default function AccountLabel({
  ss58,
  name,
  email,
  className,
  prefix,
  focusable = false,
}: {
  ss58: string;
  name?: string | null;
  email?: string | null;
  className?: string;
  /**
   * Words before the label inside the same hover target, e.g. "by ". They
   * never shorten; only the label after them does.
   */
  prefix?: string;
  /**
   * For a label that may be cut short in a list row: it takes keyboard
   * focus (which opens the same tooltip as hover) and its accessible name
   * carries the full name, email and address, since the eye may only see
   * part of them.
   */
  focusable?: boolean;
}) {
  const view = accountLabelView(ss58, name, email);
  // The full words: shortening is the line's job, from the width it gets, so
  // nothing is shortened by a character count first and then cut again.
  const full = view.isName ? view.label : view.ss58;
  return (
    <CustomTooltip2
      side="bottom"
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        "min-w-0 max-w-full",
        focusable &&
          // An underline, not a ring: the row clips its words column, which
          // would cut a ring off.
          "outline-none focus-visible:underline focus-visible:decoration-primary-50 focus-visible:underline-offset-2 dark:focus-visible:decoration-primary-brand-dark",
      )}
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
        className={cn("flex min-w-0 cursor-default items-baseline", !view.isName && "font-mono", className)}
      >
        {prefix ? <span className="shrink-0 whitespace-pre">{prefix}</span> : null}
        {/* A name that is really an email keeps its domain: the kind is read from the text. */}
        <MiddleTruncate text={full} kind={view.isName ? undefined : "address"} title={null} />
      </span>
      {focusable ? (
        <span className="sr-only">
          {view.email ? `, ${view.email}` : ""}
          {view.isName ? `, address ${view.ss58}` : ""}
        </span>
      ) : null}
    </CustomTooltip2>
  );
}

"use client";

// The Share via link dialog, opened on a file or folder that already has a
// live link: it leads with that link (copy it, see when it was made and when
// it ends, manage it) so the user always knows it exists, and keeps making a
// second link possible but secondary. The dialog's create form is unchanged
// and is what "Create a new link" opens.

import { useState } from "react";
import { BarChart3, Check, Eye, EyeOff, Link2, Lock } from "lucide-react";

import { Button, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  COPY_LINK,
  HIDDEN_DOTS,
  HIDE_LINK,
  LINK_LOCKED_NOTE,
  SHOW_LINK,
  maskedLink,
} from "@/components/page-sections/shares/insights/panelLinkMedia";
import { copyLinkLabel, linkFacts, LINK_ELSEWHERE_MESSAGE, type ExistingLink } from "./existingLink";

/** The heading over an existing link. */
export function existingLinkHeading(kind: ExistingLink["kind"]): string {
  return kind === "folder" ? "This folder already has a link" : "This file already has a link";
}

/** The sentence under the heading. */
export function existingLinkLead(link: ExistingLink): string {
  const what = link.kind === "folder" ? "folder" : "file";
  // Locked or made elsewhere, the note under the link says what to do.
  if (link.state !== "ready") return "The link still works.";
  if (link.isPrivate === true) return `People need the link and its password to open this ${what}.`;
  return `Anyone with the link can open this ${what}.`;
}

export const CREATE_ANOTHER_LABEL = "Create a new link";
export const CREATE_ANOTHER_NOTE = "This makes a separate link. The one above keeps working.";
export const MANAGE_IN_SHARED_LINKS = "Manage in Shared Links";

const PRIMARY = cn(
  "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
  "border-[#3167DD] bg-[#3167DD] text-white",
  "hover:bg-[#2454c4] hover:border-[#2454c4]",
  "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
);
const SECONDARY = "h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]";
const TEXT_BUTTON = cn(
  "inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-primary-50 hover:underline",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 dark:text-primary-brand-dark",
);
const MUTED = "text-grey-50 dark:text-grey-dark-600";

export function ExistingLinkBody({
  link,
  filename,
  onCopy,
  onManage,
  onInsights,
  onCreateAnother,
}: {
  link: ExistingLink;
  filename: string;
  /** Copy the link, or unlock and then copy it. */
  onCopy: () => void;
  /** Open Shared Links at this item's links. */
  onManage: () => void;
  /** Open the link's Insights, when it has them. */
  onInsights?: () => void;
  /** Show the create form for a second link. The dialog's own close button closes it. */
  onCreateAnother: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const ready = link.state === "ready" && Boolean(link.url);
  const facts = linkFacts(link);

  const copy = () => {
    onCopy();
    if (!ready) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="font-geist" data-testid="existing-link">
      <p className="text-base font-medium text-grey-10 dark:text-white">{existingLinkHeading(link.kind)}</p>
      <p className={cn("mt-0.5 text-sm", MUTED)}>{existingLinkLead(link)}</p>
      <p className="mb-2 mt-3 truncate text-sm text-grey-20 dark:text-grey-dark-800" title={filename}>
        {filename}
      </p>

      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-[8px] border p-2.5",
          "border-grey-80 bg-white dark:border-[#494949] dark:bg-[#1f1f1f]",
        )}
        data-testid="existing-link-field"
      >
        {ready ? (
          <Link2 className={cn("size-4 shrink-0", MUTED)} aria-hidden />
        ) : (
          <Lock className={cn("size-4 shrink-0", MUTED)} aria-hidden />
        )}
        <span className="sr-only">{ready ? "Link: " : "Link hidden"}</span>
        <span
          aria-hidden={!ready || undefined}
          className={cn(
            "min-w-0 flex-1 select-text font-mono text-xs",
            ready ? "text-grey-10 dark:text-grey-dark-800" : MUTED,
            shown ? "break-all" : "truncate",
          )}
          data-testid="existing-link-text"
        >
          {ready ? (shown ? link.url : maskedLink(link.url)) : HIDDEN_DOTS}
        </span>
        {ready && (
          <button
            type="button"
            aria-label={shown ? HIDE_LINK : SHOW_LINK}
            title={shown ? HIDE_LINK : SHOW_LINK}
            onClick={() => setShown((v) => !v)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-grey-50 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        )}
        {ready && (
          <button
            type="button"
            onClick={copy}
            title={copied ? "Copied!" : COPY_LINK}
            aria-label={COPY_LINK}
            className={cn(
              "shrink-0 rounded-md border px-1.5 py-1 transition-colors",
              copied
                ? "border-success-90 bg-success-100 text-success-50 dark:border-success-50/60 dark:bg-success-50/10 dark:text-success-50"
                : "border-grey-80 bg-grey-90 text-grey-10 hover:bg-grey-80 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#363636]",
            )}
          >
            {copied ? <Check className="size-4" /> : <Icons.Copy className="size-4" />}
          </button>
        )}
      </div>

      {link.state === "locked" && <p className={cn("mt-1.5 text-xs leading-[1.45]", MUTED)}>{LINK_LOCKED_NOTE}</p>}
      {link.state === "elsewhere" && (
        <p className={cn("mt-1.5 text-xs leading-[1.45]", MUTED)}>{LINK_ELSEWHERE_MESSAGE}</p>
      )}

      {facts.length > 0 && (
        <ul
          className={cn("mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs", MUTED)}
          aria-label="About this link"
          data-testid="existing-link-facts"
        >
          {facts.map((fact, i) => (
            <li key={fact} className="flex items-center gap-3">
              {i > 0 && <span aria-hidden className="size-[3px] rounded-full bg-current opacity-60" />}
              {fact}
            </li>
          ))}
        </ul>
      )}
      {link.count > 1 && (
        <p className={cn("mt-1.5 text-xs", MUTED)}>
          {`This ${link.kind} has ${link.count} links. This is the newest one.`}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button type="button" onClick={onManage} className={TEXT_BUTTON}>
          <Icons.Link className="size-3.5" aria-hidden />
          {MANAGE_IN_SHARED_LINKS}
        </button>
        {onInsights && (
          <button type="button" onClick={onInsights} className={TEXT_BUTTON}>
            <BarChart3 className="size-3.5" aria-hidden />
            View insights
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {link.state !== "elsewhere" && (
          <Button type="button" variant="primary" size="auto" onClick={copy} className={PRIMARY}>
            {copied ? "Copied" : copyLinkLabel(link)}
          </Button>
        )}
        {/* Secondary on purpose: the link above is usually what is wanted,
            and a second one is a separate link to keep track of. */}
        <Button type="button" variant="defaultStable" size="auto" onClick={onCreateAnother} className={SECONDARY}>
          {CREATE_ANOTHER_LABEL}
        </Button>
        <p className={cn("-mt-1 text-center text-xs", MUTED)}>{CREATE_ANOTHER_NOTE}</p>
      </div>
    </div>
  );
}

/**
 * Held while the listing that says whether the item has a link is read, so
 * the dialog never shows the create form and then swaps it for the link.
 */
export function ExistingLinkSkeleton() {
  const block = "animate-pulse rounded bg-grey-90 motion-reduce:animate-none dark:bg-white/[0.06]";
  return (
    <div className="font-geist" data-testid="existing-link-loading" aria-busy="true" aria-label="Checking for a link">
      <div className="mb-4 flex items-start gap-3">
        <div className={cn(block, "size-9 rounded-full")} />
        <div className="flex-1">
          <div className={cn(block, "h-4 w-2/3")} />
          <div className={cn(block, "mt-2 h-3 w-5/6")} />
        </div>
      </div>
      <div className={cn(block, "h-11 rounded-[8px]")} />
      <div className={cn(block, "mt-6 h-[52px] rounded-[6px]")} />
    </div>
  );
}

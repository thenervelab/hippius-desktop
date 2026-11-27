"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { DIVIDE, FOCUS, HAIRLINE, ICON_BUTTON, MUTED, STRONG } from "@/components/page-sections/shares/insights/panelStyles";
import { LockMark, useDriveUnlock } from "@/components/page-sections/shares/insights/DriveUnlock";

export interface LinkRule {
  id: string;
  label: string;
  /** On or Off; `null` for a rule whose value says it all (Allow list, Expiry). */
  on: boolean | null;
  value: string;
  /** What opens when the card is pressed; none draws a card that only reads. */
  editor?: ReactNode;
  /**
   * It can't be changed until the Drive is unlocked on this computer: it
   * shows a lock, and pressing it opens the unlock first, then its editor.
   */
  locked?: boolean;
}

const CARD_BUTTON = cn(
  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
  "first:rounded-t-[12px] hover:bg-grey-90/60 dark:hover:bg-white/[0.04]",
  FOCUS,
);

/** A locked card: pressing it unlocks the Drive, then opens its editor. */
function LockedCardButton({ rule, onOpen, children }: { rule: LinkRule; onOpen: () => void; children: ReactNode }) {
  const unlock = useDriveUnlock();
  return (
    <button type="button" data-rule={rule.id} onClick={() => unlock(onOpen)} className={CARD_BUTTON}>
      {children}
    </button>
  );
}

/**
 * A link's rules as one column of cards, each with On or Off and a short
 * value. Pressing a card with an editor pushes that editor in its place,
 * under a back arrow; one editor at a time. `onPushedChange` lets a host
 * hide what sits around the cards while an editor is open.
 */
export function RuleCards({
  rules,
  onPushedChange,
  className,
}: {
  rules: readonly LinkRule[];
  onPushedChange?: (pushed: boolean) => void;
  className?: string;
}) {
  const [pushedId, setPushedId] = useState<string | null>(null);
  const pushed = rules.find((r) => r.id === pushedId && r.editor) ?? null;
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The card to give focus back to after Back.
  const returnTo = useRef<string | null>(null);

  const isPushed = pushed !== null;
  const onPushedChangeRef = useRef(onPushedChange);
  onPushedChangeRef.current = onPushedChange;
  useEffect(() => {
    onPushedChangeRef.current?.(isPushed);
    if (isPushed) {
      backRef.current?.focus({ preventScroll: true });
    } else if (returnTo.current) {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-rule="${returnTo.current}"]`)
        ?.focus({ preventScroll: true });
      returnTo.current = null;
    }
  }, [isPushed]);

  if (rules.length === 0) return null;

  if (pushed) {
    return (
      <div className={cn("flex flex-col", className)} data-testid="rule-editor">
        <div className="mb-2.5 flex items-center gap-1.5">
          <button
            ref={backRef}
            type="button"
            aria-label="Back"
            onClick={() => {
              returnTo.current = pushed.id;
              setPushedId(null);
            }}
            className={cn(ICON_BUTTON, "-ml-1.5 size-7")}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <h4 className={cn("text-[13px] font-semibold", STRONG)}>{pushed.label}</h4>
        </div>
        {pushed.editor}
      </div>
    );
  }

  const open = (id: string) => setPushedId(id);

  return (
    <ul
      ref={listRef}
      aria-label="Rules"
      className={cn("flex flex-col divide-y rounded-[12px] border", HAIRLINE, DIVIDE, className)}
      data-testid="rule-cards"
    >
      {rules.map((rule) => {
        const body = (
          <>
            <span className="min-w-0 flex-1">
              <span className={cn("flex items-center gap-1.5 text-[13px] font-medium", STRONG)}>
                {rule.label}
                {rule.locked && <LockMark />}
              </span>
              <span className={cn("line-clamp-2 break-words text-xs", MUTED)} title={rule.value}>
                {rule.value}
              </span>
            </span>
            {/* A rule that is not a switch keeps the room, so every On and Off lines up. */}
            <span
              className={cn(
                "w-6 shrink-0 text-right text-xs font-medium",
                rule.on ? "text-primary-50 dark:text-primary-brand-dark" : MUTED,
              )}
            >
              {rule.on === null ? "" : rule.on ? "On" : "Off"}
            </span>
            {/* A card that only reads keeps the chevron's room, so every On and Off lines up. */}
            {rule.editor ? (
              <ChevronRight aria-hidden className={cn("size-4 shrink-0", MUTED)} />
            ) : (
              <span aria-hidden className="size-4 shrink-0" />
            )}
          </>
        );
        return (
          <li key={rule.id} data-testid={`rule-${rule.id}`}>
            {rule.editor && rule.locked ? (
              <LockedCardButton rule={rule} onOpen={() => open(rule.id)}>
                {body}
              </LockedCardButton>
            ) : rule.editor ? (
              <button type="button" data-rule={rule.id} onClick={() => open(rule.id)} className={CARD_BUTTON}>
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-3 px-3 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

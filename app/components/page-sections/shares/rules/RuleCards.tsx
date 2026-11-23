"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { DIVIDE, FOCUS, HAIRLINE, ICON_BUTTON, MUTED, STRONG } from "@/components/page-sections/shares/insights/panelStyles";

export interface LinkRule {
  id: string;
  label: string;
  on: boolean;
  value: string;
  /** What opens when the card is pressed; none draws a card that only reads. */
  editor?: ReactNode;
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
              <span className={cn("block text-[13px] font-medium", STRONG)}>{rule.label}</span>
              <span className={cn("block truncate text-xs", MUTED)}>{rule.value}</span>
            </span>
            <span
              className={cn(
                "shrink-0 text-xs font-medium",
                rule.on ? "text-primary-50 dark:text-primary-brand-dark" : MUTED,
              )}
            >
              {rule.on ? "On" : "Off"}
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
            {rule.editor ? (
              <button
                type="button"
                data-rule={rule.id}
                onClick={() => setPushedId(rule.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  "first:rounded-t-[12px] hover:bg-grey-90/60 dark:hover:bg-white/[0.04]",
                  FOCUS,
                )}
              >
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

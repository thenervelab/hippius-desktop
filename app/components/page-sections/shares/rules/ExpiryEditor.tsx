"use client";

import { useEffect, useId, useState } from "react";
import { useAtomValue } from "jotai";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select/Select";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { getExpiryDayRange, type ExpiryDayRange, type ShareTtl } from "@/app/lib/tauri/shares";

/** How long a link lasts: the four presets the server takes. */
export const TTL_OPTIONS: ReadonlyArray<{ label: string; value: ShareTtl }> = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "Until I revoke it", value: "never" },
];

/** The Select's value for "ends on a chosen date". */
export const ON_A_DATE = "date";
export const ON_A_DATE_LABEL = "On a date";
export const SAVE_DATE = "Save";

export interface ExpiryEdit {
  /** The preset the link has; `null` when it ends on a chosen date or is unknown. */
  ttl: ShareTtl | null;
  saving: boolean;
  onChange: (ttl: ShareTtl) => void;
  /** End it on a chosen day ("YYYY-MM-DD"); none offers the presets only. */
  onDate?: (day: string) => void;
}

/** "2026-12-20" from an RFC 3339 end, in this computer's zone; "" when unreadable. */
export function dayOf(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const t = new Date(expiresAt);
  if (Number.isNaN(t.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/**
 * The Expiry card's editor: the presets, and "On a date" with a date field
 * where the server takes a chosen end (`share_expiry_date`). Which days can
 * be picked comes from Rust (`share_expiry_day_range`, 2 hours to a year
 * ahead); the link ends at the end of the day picked.
 */
export function ExpiryEditor({ expiry, expiresAt }: { expiry: ExpiryEdit; expiresAt: string | null }) {
  const caps = useAtomValue(serverCapabilitiesAtom);
  const datesOffered = Boolean(expiry.onDate) && caps?.share_expiry_date === true;
  // Asked of Rust once the date is offered: a local answer, no request.
  const [range, setRange] = useState<{ data: ExpiryDayRange | null }>({ data: null });
  useEffect(() => {
    if (!datesOffered) return;
    let alive = true;
    getExpiryDayRange()
      .then((data) => {
        if (alive) setRange({ data });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [datesOffered]);
  const dateId = useId();
  // "On a date" picked here, before a day is saved.
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState(() => (expiry.ttl === null ? dayOf(expiresAt) : ""));
  useEffect(() => {
    if (expiry.ttl === null) setDay(dayOf(expiresAt));
  }, [expiresAt, expiry.ttl]);

  const onDate = datesOffered && range.data ? expiry.onDate : undefined;
  const showDate = Boolean(onDate) && (picking || (expiry.ttl === null && expiresAt !== null));
  const value = showDate ? ON_A_DATE : (expiry.ttl ?? undefined);
  const inRange = range.data ? day >= range.data.min && day <= range.data.max : false;
  const options: { label: string; value: string }[] = TTL_OPTIONS.map(({ label, value: v }) => ({ label, value: v }));
  if (onDate) options.push({ label: ON_A_DATE_LABEL, value: ON_A_DATE });

  return (
    <div className="flex flex-col gap-2.5">
      <Select
        ariaLabel="Link expires"
        value={value}
        placeholder="Choose how long it lasts"
        disabled={expiry.saving}
        onValueChange={(v) => {
          if (v === ON_A_DATE) {
            setPicking(true);
            return;
          }
          setPicking(false);
          expiry.onChange(v as ShareTtl);
        }}
        options={options}
      />
      {showDate && onDate && range.data && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (inRange && !expiry.saving) onDate(day);
          }}
        >
          <label htmlFor={dateId} className="sr-only">
            Ends on
          </label>
          <input
            id={dateId}
            type="date"
            value={day}
            min={range.data.min}
            max={range.data.max}
            disabled={expiry.saving}
            onChange={(e) => setDay(e.target.value)}
            className={cn(
              "h-9 min-w-0 flex-1 rounded-[8px] border px-3 text-[13px] outline-none",
              "border-grey-80 bg-white text-grey-10 focus:border-primary-50",
              "dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-white dark:[color-scheme:dark] dark:focus:border-primary-65",
            )}
          />
          <Button type="submit" variant="primary" size="sm" disabled={!inRange || expiry.saving} className="shrink-0">
            {SAVE_DATE}
          </Button>
        </form>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listen } from "@tauri-apps/api/event";
import { Lock, Trash2, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { deleteHeldRecording, getHeldRecordings, type HeldRecordings as Held } from "@/app/lib/tauri/capture";
import { cn } from "@/lib/utils";

/** Rust's event when a recording is held, released or deleted. */
export const HELD_CHANGED_EVENT = "capture_held_changed";

const NOTE = cn(
  "flex flex-wrap items-start gap-3 rounded-[8px] border px-4 py-3 text-sm",
  "border-grey-dark-100 bg-white text-grey-40 dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-600",
);

/** The count line. Rust says why they are held; this only counts them. */
export function heldTitle(count: number): string {
  return count === 1 ? "1 recording is waiting to upload" : `${count} recordings are waiting to upload`;
}

/**
 * Recordings held at the free plan's limit, on the Captures page: they stay
 * on this computer, not uploaded, until a slot frees up or the plan changes,
 * when Rust uploads them on its own (oldest first). The page offers the same
 * two ways out as the card: Upgrade, or delete one. Rust decides everything;
 * this lists what `capture_held_recordings` answers and nothing when empty.
 */
export default function HeldRecordings({ className }: { className?: string }) {
  const [held, setHeld] = useState<Held | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    void getHeldRecordings()
      .then(setHeld)
      .catch(() => setHeld(null));
  }, []);

  useEffect(() => {
    const unlisten = listen(HELD_CHANGED_EVENT, load);
    load();
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [load]);

  if (!held || held.items.length === 0) return null;

  const remove = (id: string) => {
    if (deleting) return;
    setDeleting(id);
    void deleteHeldRecording(id)
      .catch(() => undefined)
      .finally(() => {
        setDeleting(null);
        load();
      });
  };

  return (
    <section aria-label="Recordings waiting to upload" data-testid="held-recordings" className={cn(NOTE, className)}>
      <Lock aria-hidden className="mt-0.5 size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-medium text-grey-10 dark:text-white">{heldTitle(held.items.length)}</p>
        <p className="mt-0.5">{held.message}</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {held.items.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2">
              {item.thumbnail ? (
                // A data: URL from Rust; next/image does not apply.
                <img src={item.thumbnail} alt="" className="h-9 w-16 shrink-0 rounded-[4px] object-cover" />
              ) : (
                <span className="grid h-9 w-16 shrink-0 place-items-center rounded-[4px] bg-grey-light-200 dark:bg-black-500">
                  <Video aria-hidden className="size-4" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate" title={item.fileName}>
                {item.fileName}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={deleting !== null}
                onClick={() => remove(item.id)}
                aria-label={`Delete ${item.fileName}`}
                className="shrink-0"
              >
                <Trash2 aria-hidden className="size-4" />
                <span className="hidden sm:inline">Delete</span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <UpgradeButton />
    </section>
  );
}

/** Upgrade goes where every upgrade prompt goes: the plans. */
function UpgradeButton() {
  const router = useRouter();
  return (
    <Button variant="primary" size="sm" onClick={() => router.push(BILLING_ROUTE)}>
      Upgrade
    </Button>
  );
}

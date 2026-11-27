"use client";

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { activityAgo, type RecentLinkActivity } from "@/app/lib/linkActivity/linkActivity";

/**
 * "Link activity" in the tray popover: the last few events on the owner's
 * links, each opening that link's Insights, and See all, which opens Shared
 * Links. Nothing while there are none.
 */
export default function TrayLinkActivity({
  events,
  onOpen,
  onSeeAll,
}: {
  events: RecentLinkActivity[];
  onOpen: (shareToken: string | null) => void;
  onSeeAll: () => void;
}) {
  // Re-read the clock each minute so "12 min ago" stays true while open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (events.length === 0) return null;
  return (
    <section aria-labelledby="tray-link-activity" className="px-5 pt-4" data-testid="tray-link-activity">
      <div className="flex items-center justify-between gap-3">
        <h2 id="tray-link-activity" className="font-geist text-[14px] font-medium leading-7 text-grey-10 dark:text-white">
          Link activity
        </h2>
        <button
          type="button"
          onClick={onSeeAll}
          className="rounded font-geist text-[12px] font-medium text-[#3167DD] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3167DD]/40"
        >
          See all
        </button>
      </div>
      <ul>
        {events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              onClick={() => onOpen(event.shareToken)}
              className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-[rgba(0,0,0,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3167DD]/40 dark:hover:bg-[rgba(255,255,255,0.06)]"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[rgba(49,103,221,0.1)] text-[#3167DD]">
                <Link2 className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate font-geist text-[13px] text-grey-10 dark:text-white">{event.line}</span>
              <span className="shrink-0 font-geist text-[12px] text-grey-60 dark:text-grey-dark-600">
                {activityAgo(event.at, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

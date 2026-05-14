"use client";

import React from "react";

export type TicketStatus =
  | "open"
  | "pending"
  | "resolved"
  | "closed"
  // Legacy value — older tickets created before the Open/Pending split
  // can still arrive from the server; keep the type so callers compile.
  | "in_progress";

interface StatusBadgeProps {
  status: TicketStatus | string;
  /**
   * Render only the dot + label inline (no pill background). Used inside
   * the message-thread header strip where the chrome already supplies a
   * container.
   */
  textVersion?: boolean;
}

type Config = {
  /** Hex fill for the dot — drives both the solid inner circle and the
   *  0.2-opacity outer halo. The pill chrome itself stays neutral. */
  dotColor: string;
  label: string;
};

/* Every status shares the same neutral pill chrome — the dot color is
 * the ONLY visual signal that varies. This keeps the table calm even
 * when many tickets sit side by side, and meets the design ask of
 * "status color only in our circles". Hex values pulled from the
 * project's CSS tokens (--primary-50, --warning-50, --success-60). */
const STATUS_CONFIG: Record<string, Config> = {
  // Open: new ticket awaiting the first staff response.
  open: { dotColor: "#3167DD", label: "Open" },
  // Pending: replied / waiting on someone — in flight.
  pending: { dotColor: "#E89702", label: "Pending" },
  // Legacy mid-conversation state — kept so historical tickets render.
  in_progress: { dotColor: "#E89702", label: "In Progress" },
  // Resolved & Closed both read as "the ticket is done" — share the same
  // green dot so the table doesn't read as if Closed were a third
  // failure-shaped state. Anything truly unknown falls through to the
  // grey fallback below.
  resolved: { dotColor: "#04C870", label: "Resolved" },
  closed: { dotColor: "#04C870", label: "Closed" },
};

function Dot({ fill }: { fill: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 9.5 9.5"
      fill="none"
      className="flex-shrink-0"
      aria-hidden
    >
      <circle cx="4.75" cy="4.75" r="4.75" fill={fill} fillOpacity="0.2" />
      <circle cx="4.75" cy="4.75" r="2.375" fill={fill} />
    </svg>
  );
}

export default function StatusBadge({
  status,
  textVersion = false,
}: StatusBadgeProps) {
  const key = String(status ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  // Fallback for unknown server values: title-case whatever arrived and
  // colour the dot grey, matching the "Closed" treatment.
  const cfg: Config = STATUS_CONFIG[key] ?? {
    dotColor: "#8F8F8F",
    label: status
      ? String(status).charAt(0).toUpperCase() +
        String(status).slice(1).toLowerCase()
      : "—",
  };

  // Inline variant — drops the pill background so the badge can sit
  // inside other chrome (e.g. the first-message header strip).
  if (textVersion) {
    return (
      <span className="inline-flex items-center gap-1">
        <Dot fill={cfg.dotColor} />
        <span className="text-[10px] font-semibold leading-none tracking-[-0.2px] text-grey-10 dark:text-grey-light-100">
          {cfg.label}
        </span>
      </span>
    );
  }

  /* Figma spec: 20px tall, 4px / 8px padding, 49px radius, 4px gap, neutral
   * #EFEFEF pill. The dot is the only piece that carries status colour. */
  return (
    <span className="inline-flex h-[20px] items-center gap-[4px] px-[8px] py-[4px] rounded-[49px] flex-shrink-0 bg-[#EFEFEF] dark:bg-white/10">
      <Dot fill={cfg.dotColor} />
      <span className="text-[10px] font-semibold leading-none tracking-[-0.2px] text-grey-10 dark:text-grey-light-100">
        {cfg.label}
      </span>
    </span>
  );
}

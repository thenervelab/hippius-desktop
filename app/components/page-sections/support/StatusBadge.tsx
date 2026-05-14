"use client";

import React from "react";
import { cn } from "@/lib/utils";

export type TicketStatus = "open" | "closed" | "in_progress" | "resolved";

interface StatusBadgeProps {
  status: TicketStatus | string;
  /**
   * Render only the dot + label inline (no pill background). Used inside
   * the message-thread header strip where the chrome already supplies a
   * container.
   */
  textVersion?: boolean;
}

type Tone = "success" | "warning" | "neutral";

type Config = {
  tone: Tone;
  label: string;
};

const STATUS_CONFIG: Record<string, Config> = {
  // Awaiting first staff reply — surface as "Pending" in the Off (gray)
  // pill style.
  open: { tone: "neutral", label: "Pending" },
  in_progress: { tone: "warning", label: "In Progress" },
  resolved: { tone: "success", label: "Resolved" },
  closed: { tone: "success", label: "Closed" },
};

/* Mirror the On/Off pill from NotificationSection so the table reads as
 * a slimmer sibling of the toggles users see in settings. */
const TONE_CLASSES: Record<
  Tone,
  {
    pill: string;
    label: string;
    dotFill: string;
    dotInline?: React.CSSProperties;
  }
> = {
  success: {
    pill: "bg-[rgba(4,200,112,0.2)]",
    label: "",
    dotFill: "#04C870",
    dotInline: { color: "#04c870" },
  },
  warning: {
    pill: "bg-[rgba(232,151,2,0.2)]",
    label: "",
    dotFill: "#E89702",
    dotInline: { color: "#E89702" },
  },
  neutral: {
    pill: "bg-[#f0f0f0] dark:bg-white/10 text-[#b6b6b6] dark:text-grey-dark-500",
    label: "",
    dotFill: "currentColor",
  },
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
  const cfg: Config = STATUS_CONFIG[key] ?? {
    tone: "neutral",
    label: String(status ?? "—"),
  };
  const tone = TONE_CLASSES[cfg.tone];

  // Inline variant — drops the pill background so the badge can sit
  // inside other chrome (e.g. the first-message header strip).
  if (textVersion) {
    return (
      <span
        className={cn("inline-flex items-center gap-[5px]", tone.label)}
        style={tone.dotInline}
      >
        <Dot fill={tone.dotFill} />
        <span className="text-[10px] font-semibold leading-none tracking-[-0.2px]">
          {cfg.label}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] px-[8.8px] py-[5px] rounded-full flex-shrink-0",
        tone.pill
      )}
      style={tone.dotInline}
    >
      <Dot fill={tone.dotFill} />
      <span className="text-[10px] font-semibold leading-none tracking-[-0.2px]">
        {cfg.label}
      </span>
    </span>
  );
}

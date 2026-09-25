"use client";

// One inline message recipe for the Share dialog's two sections, in the three
// tones it needs. The amber is the dialogs' existing "coming soon" note (the
// migration prompt's), the red is the old invite dialog's error box, and the
// green is the success chip's palette, so none of them is new to the app.

import React from "react";
import { AlertCircle, Check } from "lucide-react";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

export type InlineNoticeTone = "info" | "error" | "success";

const TONE_CLASS: Record<InlineNoticeTone, string> = {
  info: "border-warning-50/40 bg-warning-50/10 dark:border-warning-50/35 dark:bg-warning-50/[0.12]",
  error: "border-error-90 bg-error-100/40 dark:border-error-30/60 dark:bg-error-30/10",
  success: "border-success-50/40 bg-success-100 dark:border-success-50/30 dark:bg-success-50/15",
};

function ToneIcon({ tone }: { tone: InlineNoticeTone }) {
  if (tone === "error") return <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" />;
  if (tone === "success") {
    return <Check className="mt-0.5 size-4 shrink-0 text-success-40 dark:text-success-50" />;
  }
  return <Icons.InfoCircle className="mt-0.5 size-4 shrink-0 text-warning-50" />;
}

export function InlineNotice({
  tone,
  children,
  action,
  className,
}: {
  tone: InlineNoticeTone;
  children: React.ReactNode;
  /** A follow-up the message offers, such as "Upgrade plan". */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2 rounded-lg border p-3", TONE_CLASS[tone], className)}
    >
      <ToneIcon tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-xs leading-5 text-grey-30 dark:text-grey-dark-700">
          {children}
        </p>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

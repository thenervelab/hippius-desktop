import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { InsightsAvatar } from "./InsightsAvatar";
import { ANONYMOUS } from "./insightsView";
import { MUTED, STRONG } from "./panelStyles";

/**
 * How a viewer reads: their name first with the email under it when they
 * gave both, the email alone when that is all there is, and "Anonymous
 * viewer" only when there is neither. The email is only ever one Rust
 * matched against the server's check of what they proved.
 */
export function viewerIdentity(
  name: string | null | undefined,
  email: string | null | undefined,
): { primary: string; secondary: string | null; avatar: string | null } {
  const n = name?.trim() || null;
  const e = email?.trim() || null;
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return { primary: n, secondary: e, avatar: n };
  if (n) return { primary: n, secondary: null, avatar: n };
  if (e) return { primary: e, secondary: null, avatar: e };
  return { primary: ANONYMOUS, secondary: null, avatar: null };
}

/**
 * A viewer's avatar and their one or two lines (`viewerIdentity`). Each line
 * keeps its full value and is cut with an ellipsis only when it does not
 * fit, with the whole value on hover. `aside` sits beside the first line (a
 * badge, a count); `meta` is one more muted line under them.
 */
export function ViewerIdentity({
  name,
  email,
  size = "md",
  muted = false,
  aside,
  meta,
  className,
}: {
  name: string | null | undefined;
  email?: string | null;
  size?: "row" | "md";
  muted?: boolean;
  aside?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  const who = viewerIdentity(name, email);
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-3", className)} data-testid="viewer-identity">
      <InsightsAvatar name={who.avatar} size={size} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <bdi
            title={who.primary}
            className={cn("min-w-0 truncate text-[13px] font-semibold", muted ? MUTED : STRONG)}
            data-testid="viewer-primary"
          >
            {who.primary}
          </bdi>
          {aside}
        </p>
        {who.secondary && (
          <p className={cn("mt-px min-w-0 truncate text-xs", MUTED)} title={who.secondary} data-testid="viewer-email">
            <bdi>{who.secondary}</bdi>
          </p>
        )}
        {meta}
      </div>
    </div>
  );
}

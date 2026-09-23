"use client";

/**
 * Filter a shared drive's files by who added them.
 *
 * Options come from the drive's member list rather than from the files on
 * screen: filtering by someone who has uploaded nothing yet should return
 * an empty list, not hide the option. The owner is included because they
 * upload too and hold no membership row of their own.
 *
 * The value is always an ss58 chosen from that list, never typed. A blank
 * or over-long value is a 400 server-side, and there is nothing useful a
 * free-text box could do with an address nobody can remember.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import {
  listDriveMembers,
  type DriveTarget,
} from "@/app/lib/tauri/sharedDrives";

/**
 * `uploaded_by` value selecting the files with no uploader recorded: rows
 * that predate attribution, and admin-tool writes (hcfs #456). Safe as a
 * sentinel because `_` is not in the base58 alphabet, so no account can be
 * called this.
 */
export const UPLOADED_BY_UNRECORDED = "_none";

export const DRIVE_MEMBERS_QUERY_KEY = "drive-members";

export function useDriveMembers(
  label: string | null | undefined,
  target?: DriveTarget,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: [
      DRIVE_MEMBERS_QUERY_KEY,
      label ?? "",
      target?.ownerSs58 ?? null,
      target?.folderHash ?? null,
    ],
    enabled:
      SHARED_DRIVES_ENABLED &&
      Boolean(label) &&
      options.enabled !== false,
    staleTime: 60_000,
    queryFn: () => listDriveMembers(label as string, target),
  });
}

export function useUploaderOptions(
  label: string | null | undefined,
  ownerSs58: string | undefined,
  sessionSs58: string | undefined,
  target?: DriveTarget,
) {
  const { data: members } = useDriveMembers(label, target, {
    enabled: Boolean(label) && Boolean(ownerSs58 || sessionSs58),
  });

  return useMemo(() => {
    const rows: Array<{ ss58: string; label: string }> = [];
    const push = (ss58: string, label: string) => {
      if (!ss58 || rows.some((r) => r.ss58 === ss58)) return;
      rows.push({ ss58, label });
    };
    // You first: it is the option most often wanted and the only one anyone
    // recognises on sight.
    if (sessionSs58) push(sessionSs58, "You");
    if (ownerSs58) {
      push(ownerSs58, `Owner (${middleTruncate(ownerSs58, 14)})`);
    }
    for (const m of members ?? []) {
      push(
        m.memberSs58,
        accountDisplayName(m.memberSs58, m.memberName, 22),
      );
    }
    // Files with no uploader recorded, which the ADDED BY column draws as a
    // muted "Owner". The server will not count them as the owner's (hcfs
    // #456 keeps "not recorded" apart from a real attribution), so they get
    // an option of their own, named for how the column shows them.
    if (ownerSs58) push(UPLOADED_BY_UNRECORDED, "Not recorded (shown as Owner)");
    return rows;
  }, [members, ownerSs58, sessionSs58]);
}

const FILTER_PILL_TRIGGER = cn(
  "group inline-flex h-8 items-center gap-2 whitespace-nowrap",
  "rounded-[7px] border px-[8px] pr-[10px]",
  "bg-[#fefefe] border-[#e0e0e0]",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "text-[12px] font-medium font-mono uppercase tracking-[-0.24px] leading-[20px]",
  "text-black-700 transition-colors hover:bg-grey-light-700",
  "dark:bg-[rgba(255,255,255,0.02)] dark:border-black-300 dark:text-grey-light-100",
  "dark:shadow-[0px_0px_0px_1px_rgba(0,0,0,1)] dark:hover:bg-black-500",
);

const FILTER_PILL_CONTENT = cn(
  "z-50 mt-1 max-h-[400px] min-w-[180px] overflow-y-auto rounded-lg border border-grey-dark-100 bg-white px-2 py-1 shadow-menu",
  "dark:border-black-300 dark:bg-black-primary-bg dark:shadow-[0px_0px_0px_1px_black]",
);

const FILTER_PILL_ITEM = cn(
  "group/item flex w-full cursor-pointer items-center gap-2 rounded p-2 text-xs font-medium text-grey-40 outline-none transition-colors",
  "hover:bg-grey-80 dark:text-grey-dark-800 dark:hover:bg-black-300/40 dark:hover:text-grey-light-100",
  "dark:focus:bg-black-300/40 dark:focus:text-grey-light-100",
);

export default function AddedByFilter({
  options,
  value,
  onChange,
}: {
  options: Array<{ ss58: string; label: string }>;
  value?: string;
  onChange: (_ss58: string | undefined) => void;
}) {
  // Nobody to filter by but yourself is not a filter, it is a decoration.
  if (options.length < 2) return null;

  const selected = options.find((o) => o.ss58 === value);
  const label = selected ? `Added by: ${selected.label}` : "Added by: Anyone";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Added by"
          className={cn(FILTER_PILL_TRIGGER, "min-w-[132px] max-w-[220px]")}
        >
          <span className="truncate leading-5">{label}</span>
          <ChevronDown className="size-[14px] shrink-0 text-grey-40 transition-transform duration-200 group-data-[state=open]:rotate-180 dark:text-grey-dark-700" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className={FILTER_PILL_CONTENT}>
        <DropdownMenu.Item
          className={FILTER_PILL_ITEM}
          onSelect={() => onChange(undefined)}
        >
          <span className="flex size-4 items-center justify-center">
            {value === undefined ? <Check className="size-3.5" /> : null}
          </span>
          <span className="flex-1 truncate">Anyone</span>
        </DropdownMenu.Item>
        {options.map((o) => (
          <DropdownMenu.Item
            key={o.ss58}
            className={FILTER_PILL_ITEM}
            onSelect={() => onChange(o.ss58)}
          >
            <span className="flex size-4 items-center justify-center">
              {value === o.ss58 ? <Check className="size-3.5" /> : null}
            </span>
            <span className="flex-1 truncate">{o.label}</span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

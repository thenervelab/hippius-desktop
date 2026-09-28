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
 *
 * People are named the way the ADDED BY column names them, through the same
 * `accountDisplayName`: the owner as "name (owner)", members by name, and a
 * shortened address only when no name is known (a placeholder email is
 * never a name). Only the label changes; the value stays the ss58.
 *
 * Each option returns exactly the rows the column names that way, which for
 * the owner includes the files with no uploader recorded (see
 * `lib/shared-drives/uploaderFilter.ts`).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  accountDisplayName,
  presentText,
} from "@/app/lib/shared-drives/accountLabel";
import {
  isSameUploader,
  UPLOADED_BY_UNRECORDED,
} from "@/app/lib/shared-drives/uploaderFilter";
import MiddleTruncate from "@/components/ui/MiddleTruncate";
import {
  listDriveMembers,
  type DriveTarget,
} from "@/app/lib/tauri/sharedDrives";

export { UPLOADED_BY_UNRECORDED };

/** One choice in the filter. */
export interface UploaderOption {
  /** The filter value: an ss58, or `UPLOADED_BY_UNRECORDED`. */
  ss58: string;
  /** The whole label, for the trigger and the active filter chip. */
  label: string;
  /**
   * The person's name, when one is known. The menu cuts it in the middle to
   * fit and keeps `suffix` whole beside it. Without a name the label is the
   * shortened address, short enough to draw whole.
   */
  name?: string;
  /** Drawn after the person, never cut: " (owner)". */
  suffix?: string;
}

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
  /** The owner's name, as the ADDED BY column is given it. */
  ownerName?: string,
) {
  const { data: members } = useDriveMembers(label, target, {
    enabled: Boolean(label) && Boolean(ownerSs58 || sessionSs58),
  });

  return useMemo(
    () => buildUploaderOptions({ ownerSs58, ownerName, sessionSs58, members: members ?? [] }),
    [members, ownerSs58, ownerName, sessionSs58],
  );
}

/** The options, in order: You, the owner, members, then "Not recorded". */
export function buildUploaderOptions({
  ownerSs58,
  ownerName,
  sessionSs58,
  members,
}: {
  ownerSs58?: string;
  ownerName?: string;
  sessionSs58?: string;
  members: ReadonlyArray<{ memberSs58: string; memberName?: string }>;
}): UploaderOption[] {
  const rows: UploaderOption[] = [];
  const push = (option: UploaderOption) => {
    // By account, not by string: one address written with two prefixes is
    // still one person, and one option.
    if (!option.ss58 || rows.some((r) => isSameUploader(r.ss58, option.ss58))) return;
    rows.push(option);
  };
  const personOption = (ss58: string, name: string | undefined, suffix?: string): UploaderOption => {
    const text = accountDisplayName(ss58, name);
    const shown = presentText(name);
    return {
      ss58,
      label: suffix ? `${text}${suffix}` : text,
      ...(shown ? { name: shown } : {}),
      ...(suffix ? { suffix } : {}),
    };
  };
  // You first: it is the option most often wanted and the only one anyone
  // recognises on sight.
  if (sessionSs58) push({ ss58: sessionSs58, label: "You" });
  if (ownerSs58) push(personOption(ownerSs58, ownerName, " (owner)"));
  for (const m of members) push(personOption(m.memberSs58, m.memberName));
  // Files with no uploader recorded, which the ADDED BY column draws as a
  // muted "Owner". Picking the owner returns them too, because the column
  // calls them "Owner". This option narrows to only them: the rows whose
  // "Owner" is an inference rather than a record.
  if (ownerSs58) push({ ss58: UPLOADED_BY_UNRECORDED, label: "Not recorded (shown as Owner)" });
  return rows;
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
  options: UploaderOption[];
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
            <UploaderOptionLabel option={o} />
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/**
 * One option's words in the menu. A name is cut in the middle, like
 * everywhere else a person is named, and "(owner)" after it stays whole, so
 * a long owner name still reads as the owner.
 */
function UploaderOptionLabel({ option }: { option: UploaderOption }) {
  if (!option.name) {
    return <span className="flex-1 truncate">{option.label}</span>;
  }
  return (
    <span
      className="flex min-w-0 max-w-[240px] flex-1 items-center"
      // The whole name, and the address that tells two of them apart.
      title={`${option.label}\n${option.ss58}`}
    >
      <MiddleTruncate text={option.name} title={null} />
      {option.suffix ? <span className="shrink-0 whitespace-pre">{option.suffix}</span> : null}
    </span>
  );
}

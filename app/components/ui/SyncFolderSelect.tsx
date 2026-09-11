"use client";

import { FC, useCallback, useEffect, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Check, Cloud, Folder } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import { listRemoteFolders } from "@/app/lib/utils/restoreUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

/** Drives on the account that this computer does not sync. */
export const REMOTE_UPLOAD_TARGETS_QUERY_KEY = "remoteUploadTargets";

/**
 * Hover text for one option. Names what a remote folder IS rather than
 * what it lacks — the files go straight to the server, which is an
 * ordinary destination, not a limitation.
 */
function optionTitle(sp: { label: string; remote: boolean }): string {
  return sp.remote
    ? `${sp.label} — a remote folder, stored on Hippius but not synced to this computer`
    : sp.label;
}

interface SyncFolderSelectProps {
  value: string | null;
  /**
   * `path` is empty for a drive that is not synced on this computer, and
   * `remote` says so explicitly rather than leaving the caller to infer it
   * from the empty string — an upload routed to the wrong side either
   * lands in the wrong drive or fails.
   */
  onChange: (label: string, path: string, remote: boolean) => void;
  defaultLabel?: string | null;
  className?: string;
  /**
   * Whether drives that are NOT synced on this computer are offered.
   *
   * They upload straight to the server, so the destination is real — but
   * only where the caller can actually route there.
   */
  includeRemote?: boolean;
  /**
   * Field label. Defaults to the upload wording this was written for;
   * the New Folder dialog picks where to CREATE, not where to upload, and
   * "Upload to folder" there would describe the wrong action.
   */
  label?: string;
}

interface SyncFolderOption {
  label: string;
  path: string;
  remote: boolean;
}

const SyncFolderSelect: FC<SyncFolderSelectProps> = ({
  value,
  onChange,
  defaultLabel,
  className,
  includeRemote = false,
  label = "Upload to folder",
}) => {
  // Read configured drives from the per-drive status atom (single source
  // of truth, hydrated by `useDriveStatuses`). No DB round-trip needed —
  // every entry already carries `label + path`.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const driveStatusesLoaded = useAtomValue(driveStatusesLoadedAtom);
  const { polkadotAddress } = useWalletAuth();
  const localPaths = useMemo<SyncFolderOption[]>(
    () =>
      Array.from(driveStatuses.entries())
        .filter(([, entry]) => !!entry.path)
        .map(([label, entry]) => ({ label, path: entry.path, remote: false })),
    [driveStatuses]
  );

  // Drives that exist on the account but are not synced here have no local
  // path, so they are absent from the drive-status map entirely. They are
  // still valid upload destinations — the files go straight to the server
  // — so they are fetched separately and listed under their own heading.
  const { data: remoteFolders } = useQuery({
    queryKey: [REMOTE_UPLOAD_TARGETS_QUERY_KEY, polkadotAddress],
    queryFn: () => listRemoteFolders(polkadotAddress as string),
    enabled: includeRemote && Boolean(polkadotAddress),
    staleTime: 60_000,
  });

  const remotePaths = useMemo<SyncFolderOption[]>(() => {
    if (!includeRemote || !remoteFolders) return [];
    const local = new Set(localPaths.map((p) => p.label));
    return remoteFolders
      .map((f) => f.label)
      // A drive synced here appears in the local list already; listing it
      // twice would offer the same drive by two different routes.
      .filter((label) => label.length > 0 && !local.has(label))
      .map((label) => ({ label, path: "", remote: true }));
  }, [includeRemote, remoteFolders, localPaths]);

  const syncPaths = useMemo<SyncFolderOption[]>(
    () => [...localPaths, ...remotePaths],
    [localPaths, remotePaths],
  );

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Where to draw the menu, in viewport coordinates.
  //
  // The menu is portalled to `<body>` and positioned `fixed` rather than
  // absolutely inside this component. Every caller is a dialog, and an
  // absolutely-positioned child still counts toward its scroll
  // container's overflow — so opening the menu grew the dialog and gave
  // it a scrollbar instead of drawing over it.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Which element to portal into.
  //
  // `document.body` is the obvious answer and the wrong one inside a
  // dialog: Radix's Dialog runs `react-remove-scroll`, which calls
  // `preventDefault()` on every wheel event that lands outside the dialog
  // content. The menu appeared, showed a scrollbar, and refused to
  // scroll — there is no attribute to opt out of that lock, only a
  // `shards` prop Radix does not expose.
  //
  // Portalling into the dialog itself puts the menu inside the lock, so
  // the wheel works. Its `fixed` coordinates stay viewport-relative
  // because the dialog content sets no transform; one there would become
  // the containing block and shift the menu.
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (rect) setAnchor(rect);
    setContainer(trigger?.closest<HTMLElement>('[role="dialog"]') ?? document.body);
    setOpen((prev) => !prev);
  }, []);

  // Resolve initial selection: prefer the controlled `value`, then
  // `defaultLabel`, then the first drive. Runs whenever the drive list
  // or controlled value changes.
  useEffect(() => {
    if (!driveStatusesLoaded || syncPaths.length === 0) return;
    const match = value
      ? syncPaths.find((sp) => sp.label === value)
      : (syncPaths.find((sp) => sp.label === defaultLabel) ?? syncPaths[0]);
    // A remote drive has no path, so `match.path` cannot be the guard —
    // that is what kept remote destinations from ever being selected.
    if (match) {
      onChange(match.label, match.path, match.remote);
    }
    // `onChange` is intentionally excluded — callers commonly pass
    // inline functions and we don't want to thrash the selection on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveStatusesLoaded, syncPaths, value, defaultLabel]);

  // Close on outside click, Escape, or anything that moves the trigger.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu lives in a portal, so it is NOT inside `containerRef`.
      // Checking only that one closed the menu on `mousedown` before the
      // option's `click` could fire, and the selection never happened.
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // A fixed menu does not follow its trigger, so rather than track the
    // trigger on every frame it closes — the same choice the app's
    // right-click menu makes.
    const close = () => setOpen(false);
    // ...but NOT when the scroll came from inside the menu. The listener
    // is capturing, so it also sees the option list scrolling itself,
    // which closed the menu the moment the user tried to reach an option
    // below the fold.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  if (!driveStatusesLoaded || syncPaths.length < 2) return null;

  const selectedLabel = syncPaths.find((sp) => sp.label === value)?.label;

  return (
    <div className={cn("flex flex-col gap-1.5", className)} ref={containerRef}>
      <label className="text-sm font-medium text-grey-50 dark:text-grey-dark-700">
        {label}
      </label>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={openMenu}
          className="flex w-full justify-between cursor-pointer items-center gap-2 px-4 h-[3rem] text-sm font-medium border border-grey-80 rounded-lg text-grey-10 bg-grey-100 focus:outline-none dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-white dark:hover:bg-[#252525]"
        >
          <span className="truncate">{selectedLabel ?? "Select folder"}</span>
          <Icons.ChevronDown
            className={cn(
              "h-5 w-5 text-grey-50 shrink-0 transition-transform duration-200 dark:text-[#7d7d7d]",
              open && "rotate-180"
            )}
          />
        </button>
      </div>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            // Fixed and portalled: inside the dialog this would add to the
            // scroll area instead of drawing over it. `z-[2000]` clears the
            // dialog's own layer.
            style={{
              position: "fixed",
              left: anchor.left,
              top: anchor.bottom + 4,
              width: anchor.width,
            }}
            className="z-[2000] overflow-hidden rounded-lg border border-grey-80 bg-white shadow-[0px_12px_32px_8px_rgba(51,51,51,0.12)] dark:border-[#494949] dark:bg-[#1f1f1f] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.4)]"
          >
            <div className="custom-scrollbar-thin flex max-h-[288px] flex-col gap-0.5 overflow-y-auto p-1.5">
              {syncPaths.map((sp) => {
                const isSelected = sp.label === value;
                return (
                  <div
                    key={sp.label}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(sp.label, sp.path, sp.remote);
                      setOpen(false);
                    }}
                    title={optionTitle(sp)}
                    className={cn(
                      "group flex cursor-pointer select-none items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150",
                      isSelected
                        ? "bg-primary-50/10 dark:bg-primary-50/15"
                        : "hover:bg-grey-90 dark:hover:bg-[#2c2c2c]",
                    )}
                  >
                    {/* The icon says which KIND of drive this is at a
                        glance, which the old badge said only in words and
                        only for one of the two. */}
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-[7px] transition-colors",
                        isSelected
                          ? "bg-primary-50 text-white"
                          : "bg-grey-90 text-grey-50 group-hover:bg-grey-80 dark:bg-[#2c2c2c] dark:text-grey-dark-600 dark:group-hover:bg-[#353535]",
                      )}
                    >
                      {sp.remote ? (
                        <Cloud className="size-4" />
                      ) : (
                        <Folder className="size-4" />
                      )}
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          "truncate text-[15px] leading-5 tracking-[-0.3px]",
                          isSelected
                            ? "font-semibold text-primary-50 dark:text-primary-brand-dark"
                            : "font-medium text-grey-10 dark:text-white",
                        )}
                      >
                        {sp.label}
                      </span>
                      <span className="truncate text-[12px] leading-4 text-grey-50 dark:text-grey-dark-600">
                        {sp.remote ? "Remote folder" : "On this computer"}
                      </span>
                    </span>

                    {isSelected && (
                      <Check className="size-4 shrink-0 text-primary-50 dark:text-primary-brand-dark" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>,
          container ?? document.body,
        )}
    </div>
  );
};

export default SyncFolderSelect;

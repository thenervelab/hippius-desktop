"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

interface SyncFileEntry {
  name: string;
  is_folder: boolean;
  size: number;
  modified: number | null;
  arion_hash?: string;
  arion_cid?: string;
  sync_status?: string;
  /** SS58 of whoever uploaded this revision, when the server attributes it. */
  uploaded_by?: string | null;
}

interface GroupedListing {
  folders: SyncFileEntry[];
  files: SyncFileEntry[];
  pendingBackfill: boolean;
}

/** One page of a remote drive level (`list_remote_folder_grouped`). */
interface RemoteGroupedPage {
  folders: SyncFileEntry[];
  files: SyncFileEntry[];
  hasMore: boolean;
  totalCount: number;
}

/**
 * Server page size for remote levels. Small on purpose — remote browsing is
 * scroll-driven lazy loading (console/mobile behavior): one page paints
 * immediately, and the NEXT page is fetched only when the user scrolls near
 * the bottom of what's loaded. A flat 8k-entry camera roll therefore costs
 * one small request up front instead of an 18-page walk.
 */
const REMOTE_PAGE_SIZE = 50;

/**
 * How long an in-flight fetch may dedupe same-key re-runs before it is
 * presumed hung and superseded. Tauri invokes have no client-side timeout,
 * so without this a request that never settles would swallow every future
 * attempt for that folder — a permanent skeleton until app reload.
 */
const STALE_FETCH_MS = 60_000;

/**
 * Cooldown after a failed `loadMore` page. The container's prefetch effect
 * re-fires on every render, so without a floor a failing page becomes a
 * zero-delay retry loop hammering the server; a scroll after the cooldown
 * still retries the same offset.
 */
const LOAD_MORE_RETRY_COOLDOWN_MS = 3_000;

interface UseNestedFolderListingOptions {
  /** Polkadot address — call is disabled until truthy. */
  accountId: string | null | undefined;
  /** Sync root path. Empty/null disables the call (ignored in remote mode). */
  syncPath: string | null | undefined;
  /**
   * Relative subfolder path inside the sync root (e.g. "Photos/2024").
   * Pass `null` for the root listing of the sync folder.
   */
  subfolder: string | null | undefined;
  /** Drive label — needed by Rust to merge the rel-path index overlay. */
  label: string | null | undefined;
  /** When this changes, the listing is re-fetched without showing a full loader. */
  refreshKey?: number;
  /** Skip the fetch entirely (e.g. when not in nested mode). */
  enabled: boolean;
  /**
   * REMOTE mode: the drive exists only on the server (no local sync path).
   * Rows come from `list_remote_folder_grouped` (same wire shape), and the
   * mapper marks file rows cloud-only — `fileId` set, `source` undefined —
   * so the existing download/preview/rename gates route them correctly.
   */
  remote?: boolean;
  /**
   * REMOTE mode, for a drive shared with this account that is NOT synced
   * here: its wire identity, since there is no local row to resolve a label
   * against. Listing needs no folder key — `/browse` returns names and paths
   * in plaintext and authorises any member of the named drive; the key is
   * only wanted to open a file's contents.
   */
  sharedDrive?: { ownerSs58: string; folderHash: string } | null;
  /**
   * PAGED mode: which page to show, 1-based.
   *
   * Omit it and the hook behaves exactly as before: one small remote page
   * plus scroll-driven `loadMore` appends, or the whole local listing. That
   * default is what keeps `ExpandedFolderRows` (inline subtrees, no room for
   * a pager) working untouched.
   *
   * Supplied, the page becomes part of the request key, so changing it is
   * handled by the same generation and dedupe machinery that handles
   * navigating to another folder: a superseded page's late result is
   * dropped rather than painted over the page now on screen.
   */
  page?: number;
  /** PAGED mode: rows per page. Ignored when `page` is omitted. */
  pageSize?: number;
  /**
   * Server-side sort for a REMOTE level, applied to the whole folder before
   * paging. A local level arrives whole and is sorted by the table instead,
   * so these are ignored there.
   */
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

/**
 * Sentinel `source` value carried by REMOTE folder rows (and remote nested
 * URLs' `folderSource` param): `remote://<label>`. Folder rows need *some*
 * source for the folder-URL builders to thread through, and this one lets
 * `DriveContainer` recognize a nested navigation as remote and recover the
 * drive label without a local path existing.
 */
export const REMOTE_SOURCE_PREFIX = "remote://";

/** The drive label out of a `remote://<label>` source, or null. */
export function remoteLabelFromSource(source: string | null | undefined): string | null {
  if (!source || !source.startsWith(REMOTE_SOURCE_PREFIX)) return null;
  const label = source.slice(REMOTE_SOURCE_PREFIX.length);
  return label.length > 0 ? label : null;
}

interface UseNestedFolderListingResult {
  /** Folder rows + file rows, folders-first, mapped to FormattedUserFile. */
  data: FormattedUserFile[];
  /** True only on the initial load for the current (syncPath, subfolder) pair. */
  isLoading: boolean;
  /** True for background refreshes triggered by `refreshKey`. */
  isRefreshing: boolean;
  /** Manually trigger a background refresh. */
  refresh: () => void;
  error: unknown;
  /**
   * REMOTE mode only: more entries exist at this level on the server beyond
   * what `data` holds. Always false in local mode (local listings load whole).
   */
  hasMore: boolean;
  /**
   * REMOTE mode only: fetch the next server page and append it. No-op while
   * a page is already in flight, when nothing more exists, or in local mode.
   * Wire this to the scroll sentinel so pages load as the user reaches them.
   */
  loadMore: () => void;
  /** REMOTE mode only: a `loadMore` page is currently on the wire. */
  isLoadingMore: boolean;
  /**
   * PAGED mode: how many entries this level holds in total, for the pager.
   *
   * Remote takes it from the server's own count, so the pager knows the last
   * page without walking there. Local counts the listing it already holds.
   * Zero when the level has not loaded yet.
   */
  totalCount: number;
}

/**
 * Fetches a single nested folder's contents from the Rust sync engine.
 *
 * Mirrors the data path the old FolderView used (now removed): one IPC call
 * to `list_sync_folder_grouped`, mapped into `FormattedUserFile[]` so the
 * existing DriveContent / FilesTable / CardView components can render it
 * without changes.
 */
export function useNestedFolderListing({
  accountId,
  syncPath,
  subfolder,
  label,
  refreshKey,
  enabled,
  remote = false,
  sharedDrive = null,
  page,
  pageSize,
  sortBy,
  sortDir,
}: UseNestedFolderListingOptions): UseNestedFolderListingResult {
  // One flag, derived once: a caller that supplies a page is paging.
  const paged = typeof page === "number" && page >= 1;
  const rowsPerPage =
    paged && typeof pageSize === "number" && pageSize >= 1
      ? pageSize
      : REMOTE_PAGE_SIZE;
  // Remote pages come from the server, so the server has to be told which
  // one; a local listing arrives whole and is sliced below.
  const pageOffset = paged ? ((page as number) - 1) * rowsPerPage : 0;
  const [data, setData] = useState<FormattedUserFile[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [manualRefreshKey, setManualRefreshKey] = useState(0);
  // The (syncPath, subfolder) tuple that produced the current `data`. While
  // it disagrees with the requested tuple, we surface the initial loader
  // instead of stale rows from a previous folder.
  const lastLoadedKeyRef = useRef<string | null>(null);
  // Bumped after every settled (success or error) fetch so the render-time
  // `isLoading` derivation re-evaluates against the new `lastLoadedKeyRef`.
  // A bare ref mutation wouldn't trigger a re-render on its own.
  const [, forceRender] = useState(0);
  // The key of a fetch currently on the wire. A re-run of the effect for the
  // SAME key (a `refreshKey` bump from the 3s sync-event dispatcher) must NOT
  // start a duplicate walk — and, critically, must not discard the one in
  // flight. The old per-effect `cancelled` flag did exactly that: with an
  // active sync re-bumping every ~3s and a multi-page remote walk taking
  // longer than that, every walk was cancelled before landing and the
  // skeleton never resolved (observed live: 720 /browse requests, 0 results
  // applied). Dropping a refresh that raced an in-flight fetch is safe — the
  // next bump (or the fetch's own result) covers it.
  const inFlightKeyRef = useRef<string | null>(null);
  // What the hook wants RIGHT NOW — results are applied only while their key
  // still matches, so navigating to a different folder discards a stale
  // fetch without discarding same-key refreshes.
  const currentKeyRef = useRef<string | null>(null);
  // Remote lazy paging: whether the server holds more entries at this level,
  // the offset the next page starts at, and a single-flight latch for
  // `loadMore` (scroll sentinels fire in bursts).
  const [remoteHasMore, setRemoteHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const remoteNextOffsetRef = useRef(0);
  // What the level holds in total, for the pager. Remote gets it from the
  // server; local is the length of the listing it already has.
  const [remoteTotalCount, setRemoteTotalCount] = useState(0);
  const loadingMoreRef = useRef(false);
  // A same-key bump (manual refresh, files-mutated event) that raced an
  // in-flight fetch is REMEMBERED and re-run when that fetch settles — the
  // dedupe must never silently eat a refresh that was requested after the
  // in-flight read started (it may be reading pre-mutation state).
  const pendingRerunRef = useRef(false);
  // When the current in-flight fetch started — lets a fetch that never
  // settles be superseded instead of bricking the folder (STALE_FETCH_MS).
  const inFlightStartedAtRef = useRef(0);
  // Fetch generation: bumped whenever a new initial fetch starts. Results
  // (initial AND loadMore pages) apply only if the generation is unchanged,
  // so a refresh can't interleave with a stale in-flight page append.
  const fetchGenRef = useRef(0);
  // Which request key produced the rows currently in `data` — so an error
  // for folder B never leaves folder A's rows rendered under B's crumb.
  const dataKeyRef = useRef<string | null>(null);
  const lastLoadMoreFailAtRef = useRef(0);

  const refresh = useCallback(() => {
    setManualRefreshKey((prev) => prev + 1);
  }, []);

  // Composite request key — null when the hook is disabled or the
  // underlying inputs aren't ready yet. Compared against
  // `lastLoadedKeyRef` to decide whether the data we hold matches the
  // currently-requested folder.
  // Remote drives have no local sync path — their root key is the label.
  // A shared drive's wire identity is part of its root key, not just its
  // label: two owners' drives can carry the same display name, and keying on
  // the label alone would serve one drive's rows under the other's name.
  const sharedKeyPart = sharedDrive
    ? `::${sharedDrive.ownerSs58}:${sharedDrive.folderHash}`
    : "";
  const rootKey = remote
    ? label
      ? `${REMOTE_SOURCE_PREFIX}${label}${sharedKeyPart}`
      : null
    : syncPath || null;

  // The page is part of the key ONLY in paged remote mode: that is the one
  // case where a different page is a different request. A local listing
  // arrives whole, so re-fetching it per page would be a round-trip for a
  // slice the hook already holds.
  const sortKeyPart = remote && sortBy ? `::s${sortBy}:${sortDir ?? "asc"}` : "";
  const pageKeyPart =
    paged && remote ? `::p${page}:${rowsPerPage}${sortKeyPart}` : "";
  const requestKey =
    enabled && accountId && rootKey
      ? `${rootKey}::${subfolder ?? ""}${pageKeyPart}`
      : null;
  currentKeyRef.current = requestKey;

  // Synchronous loading flag — true the moment we know we're "supposed to
  // be loading" but haven't successfully loaded the current request yet.
  // This covers three transitional states that all otherwise render the
  // "no entries" empty state by mistake while the URL is mid-flip:
  //
  //   1. `enabled` just flipped true but `syncPath` / `accountId` are still
  //      null because the parent useMemo / atom read hasn't settled yet
  //      (requestKey === null while enabled is true).
  //   2. requestKey is populated but doesn't match `lastLoadedKeyRef` —
  //      i.e. a different folder is requested than the one we last loaded.
  //   3. The effect hasn't run yet on the first render after enable.
  //
  // Deriving (rather than `useState`-ing) sidesteps the
  // "useState(false) → first render → effect sets true → re-render" race
  // that caused the brief empty-state flash on navigation.
  const isLoading =
    enabled && (requestKey === null || lastLoadedKeyRef.current !== requestKey);

  // Row mapper shared by the initial fetch and remote `loadMore` appends.
  // REMOTE rows are cloud-only: file rows carry `fileId` (the hex path_hash
  // the listing puts in arion_hash — the id download_remote_file /
  // cache_remote_file take) and NO `source`, which is exactly the
  // discriminant the existing download, rename and reveal gates key on.
  // Folder rows carry the `remote://<label>` sentinel source so the
  // folder-URL builders thread a recognizable `folderSource` into nested
  // navigation.
  const mapEntries = useCallback(
    (entries: SyncFileEntry[]): FormattedUserFile[] =>
      entries.map((entry) => {
        const modifiedMs = (entry.modified ?? 0) * 1000;
        const actualFileName =
          subfolder && !entry.is_folder
            ? `${subfolder}/${entry.name}`
            : entry.name;
        // The local path is computed only in local mode — in remote mode
        // `syncPath` is empty, and a "null/…"-shaped string must never
        // exist for a future consumer to pick up by accident.
        const source = remote
          ? entry.is_folder
            ? `${REMOTE_SOURCE_PREFIX}${label ?? ""}`
            : undefined
          : subfolder
            ? `${syncPath}/${subfolder}/${entry.name}`
            : `${syncPath}/${entry.name}`;
        return {
          name: entry.name,
          actualFileName,
          size: entry.size,
          createdAt: modifiedMs,
          arionHash: entry.arion_hash || "",
          arionCid: entry.arion_cid || "",
          fileId:
            remote && !entry.is_folder
              ? entry.arion_hash || undefined
              : undefined,
          source,
          minerIds: [],
          isAssigned: entry.is_folder || entry.sync_status === "synced",
          lastChargedAt: modifiedMs,
          isFolder: entry.is_folder,
          type: "private",
          isErasureCoded: false,
          mainReqHash: "",
          label: label || undefined,
          // Where a FOLDER row lives. Its `actualFileName` is only the
          // basename (the line above keeps the path off the name), so
          // without this a rename or a share addresses a folder of the
          // same name at the DRIVE ROOT instead of the one on screen.
          parentRelativePath: entry.is_folder ? subfolder || undefined : undefined,
          // Every row of a browsed remote drive, files included — the
          // `remote://` source only ever reached folder rows.
          remoteDriveLabel: remote ? label || undefined : undefined,
          uploadedBy: entry.uploaded_by || undefined,
          syncStatus:
            (entry.sync_status as FormattedUserFile["syncStatus"]) ??
            "unknown",
        };
      }),
    [remote, subfolder, syncPath, label],
  );

  useEffect(() => {
    if (!enabled || !accountId || !rootKey) {
      setData([]);
      setIsRefreshing(false);
      setError(null);
      setRemoteHasMore(false);
      lastLoadedKeyRef.current = null;
      return;
    }

    const effectRequestKey = `${rootKey}::${subfolder ?? ""}${pageKeyPart}`;
    // A fetch for this exact key is already on the wire — let it land
    // instead of restarting it, but REMEMBER the bump so it re-runs when
    // the in-flight fetch settles (it may be reading pre-mutation state).
    // Past STALE_FETCH_MS the in-flight fetch is presumed hung and this run
    // supersedes it (the generation guard drops its late result).
    if (inFlightKeyRef.current === effectRequestKey && Date.now() - inFlightStartedAtRef.current < STALE_FETCH_MS) {
      pendingRerunRef.current = true;
      return;
    }
    inFlightKeyRef.current = effectRequestKey;
    inFlightStartedAtRef.current = Date.now();
    const gen = ++fetchGenRef.current;

    const isInitialLoad = lastLoadedKeyRef.current !== effectRequestKey;
    if (!isInitialLoad) {
      // Same folder, triggered by `refreshKey` or `manualRefreshKey` —
      // keep current rows visible and just flag the spinner.
      setIsRefreshing(true);
    }

    // Marks the current request as loaded so the render-time `isLoading`
    // derivation drops the skeleton.
    const markLoaded = () => {
      lastLoadedKeyRef.current = effectRequestKey;
      setError(null);
      forceRender((tick) => tick + 1);
    };

    // Results apply only while (a) this is still the folder the hook wants
    // (navigation away discards; a same-key refresh bump does not) and
    // (b) no newer fetch generation superseded this one.
    const stillCurrent = () =>
      currentKeyRef.current === effectRequestKey && fetchGenRef.current === gen;

    (async () => {
      try {
        if (remote) {
          // ONE small page — remote browsing is scroll-driven lazy loading
          // (console/mobile behavior). The next page is fetched by
          // `loadMore` when the user scrolls near the bottom, so a flat
          // 8k-entry camera roll costs one request up front and the row
          // array only grows as far as the user actually scrolls.
          const serverPage = await invoke<RemoteGroupedPage>(
            "list_remote_folder_grouped",
            {
              accountId,
              label: label || "",
              subfolder: subfolder || "",
                offset: pageOffset,
              limit: rowsPerPage,
              sortBy: sortBy ?? null,
              sortOrder: sortDir ?? null,
              ownerSs58: sharedDrive?.ownerSs58 ?? null,
              folderHash: sharedDrive?.folderHash ?? null,
            },
          );
          if (!stillCurrent()) return;

          const pageEntries: SyncFileEntry[] = [
            ...serverPage.folders,
            ...serverPage.files,
          ];
          setData(mapEntries(pageEntries));
          dataKeyRef.current = effectRequestKey;
          remoteNextOffsetRef.current = pageOffset + pageEntries.length;
          setRemoteTotalCount(serverPage.totalCount);
          // Nothing scrolls in paged mode: the pager owns navigation, and a
          // sentinel appending page 2 under page 1 is the bug this replaces.
          setRemoteHasMore(paged ? false : serverPage.hasMore);
          markLoaded();
          return;
        }

        const listing = await invoke<GroupedListing>(
          "list_sync_folder_grouped",
          {
            accountId,
            syncPath,
            subfolder: subfolder || null,
            label: label || null,
          },
        );
        if (!stillCurrent()) return;
        setData(mapEntries([...listing.folders, ...listing.files]));
        dataKeyRef.current = effectRequestKey;
        markLoaded();
      } catch (err) {
        if (!stillCurrent()) return;
        console.error("[useNestedFolderListing] fetch failed:", err);
        setError(err);
        // The rows on screen belong to a DIFFERENT folder — clear them, or
        // the error state renders folder A's listing under folder B's
        // breadcrumb (with row actions resolving against B's paths).
        if (dataKeyRef.current !== effectRequestKey) {
          setData([]);
          dataKeyRef.current = effectRequestKey;
          setRemoteHasMore(false);
        }
        // Mark the key as "we tried" so the derived `isLoading` flips back
        // to false even on failure — otherwise the spinner would hang
        // forever and the user would never see the empty / error state.
        lastLoadedKeyRef.current = effectRequestKey;
      } finally {
        // Only the CURRENT generation may clear the latch — a superseded
        // (presumed-hung) fetch settling late must not release a newer run's.
        if (fetchGenRef.current === gen && inFlightKeyRef.current === effectRequestKey) {
          inFlightKeyRef.current = null;
        }
        if (stillCurrent()) {
          setIsRefreshing(false);
          // Trigger a re-render so the render-time `isLoading` derivation
          // re-reads the updated `lastLoadedKeyRef`.
          forceRender((tick) => tick + 1);
          // A bump arrived while this fetch was on the wire — honor it now
          // so a refresh requested mid-fetch is never silently lost.
          if (pendingRerunRef.current) {
            pendingRerunRef.current = false;
            setManualRefreshKey((prev) => prev + 1);
          }
        }
      }
    })();
    // `paged`, `pageOffset` and `rowsPerPage` are deliberately absent from
    // the deps below. All three are encoded in `pageKeyPart` for the one
    // mode that re-fetches on a page change (paged remote); listing them
    // directly ALSO re-runs this effect for a LOCAL page change, which is a
    // round-trip for a slice the hook already holds. Pinned by the "slices a
    // local listing in the client instead of re-fetching it" test.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accountId,
    syncPath,
    subfolder,
    label,
    refreshKey,
    manualRefreshKey,
    enabled,
    remote,
    rootKey,
    mapEntries,
    // Encoded in `rootKey`, but named so the effect re-runs when the drive
    // being browsed changes without its display label changing.
    sharedDrive?.ownerSs58,
    sharedDrive?.folderHash,
    // A different page is a different request, so it has to re-run the
    // effect. `pageKeyPart` alone, because it already encodes the page AND
    // the size for the one mode that re-fetches, and is the empty string in
    // local and unpaged modes. Listing `pageOffset`/`rowsPerPage` here
    // instead re-ran the effect for a LOCAL page change too, which is a
    // round-trip for a slice the hook already holds.
    pageKeyPart,
  ]);

  // Fetch-and-append the next remote page. Driven by the table's scroll
  // sentinel via DriveContainer; single-flight so sentinel bursts don't
  // stack requests, and key-guarded so a page from a folder the user has
  // already left is dropped.
  const loadMore = useCallback(() => {
    // Inert while paging: the pager decides which rows are on screen, and a
    // scroll sentinel appending the next page underneath would put two pages
    // in one view and desync the pager from what is rendered.
    if (paged) return;
    if (!remote || !enabled || !accountId || !requestKey) return;
    if (!remoteHasMore || loadingMoreRef.current) return;
    // The initial fetch for this key is still in flight — let it land first.
    if (inFlightKeyRef.current === requestKey) return;
    // After a failed page, hold off briefly: the container's prefetch effect
    // re-fires per render, and an immediate retry loop would hammer the
    // server with zero delay. Scrolling after the cooldown retries.
    if (Date.now() - lastLoadMoreFailAtRef.current < LOAD_MORE_RETRY_COOLDOWN_MS) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    const pageKey = requestKey;
    // Captured generation: a refresh replaces the list with page 0 and
    // resets the offset — a stale in-flight page from before the refresh
    // must be dropped, or it appends rows 200-249 straight after page 0.
    const gen = fetchGenRef.current;
    const offset = remoteNextOffsetRef.current;
    void (async () => {
      try {
        const serverPage = await invoke<RemoteGroupedPage>(
          "list_remote_folder_grouped",
          {
            accountId,
            label: label || "",
            subfolder: subfolder || "",
            offset,
            limit: REMOTE_PAGE_SIZE,
            ownerSs58: sharedDrive?.ownerSs58 ?? null,
            folderHash: sharedDrive?.folderHash ?? null,
          },
        );
        if (currentKeyRef.current !== pageKey || fetchGenRef.current !== gen) return;
        const pageEntries: SyncFileEntry[] = [
          ...serverPage.folders,
          ...serverPage.files,
        ];
        setData((prev) => [...prev, ...mapEntries(pageEntries)]);
        remoteNextOffsetRef.current = offset + pageEntries.length;
        setRemoteTotalCount(serverPage.totalCount);
        setRemoteHasMore(serverPage.hasMore && pageEntries.length > 0);
      } catch (err) {
        if (currentKeyRef.current !== pageKey || fetchGenRef.current !== gen) return;
        console.error("[useNestedFolderListing] loadMore failed:", err);
        lastLoadMoreFailAtRef.current = Date.now();
        // Keep hasMore true so a later scroll retries the same offset.
      } finally {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    })();
  }, [paged, remote, enabled, accountId, requestKey, remoteHasMore, label, subfolder, mapEntries]);

  // A remote page is already exactly the rows for `page`, because the server
  // was asked for that window. A LOCAL listing arrives whole and is returned
  // whole: the container slices every non-remote view (the drive root
  // included, which this hook never sees), so slicing here as well took the
  // page twice.
  return {
    data,
    isLoading,
    isRefreshing,
    refresh,
    error,
    hasMore: remote ? remoteHasMore : false,
    loadMore,
    isLoadingMore: remote ? isLoadingMore : false,
    totalCount: remote ? remoteTotalCount : data.length,
  };
}

export default useNestedFolderListing;

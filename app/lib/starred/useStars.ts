"use client";

// The star every surface shows and toggles: one Starred listing, the drive
// scopes the keys are built from, and this session's own toggles.
//
// The query client comes from the jotai atom (as `useDeleteFile` takes it), so
// a surface rendered without a QueryClientProvider (a leaf test) still works:
// it simply has no account and asks Rust nothing.

import { useCallback, useEffect, useMemo } from "react";
import { atom, useAtom, useAtomValue } from "jotai";
import { useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { queryClientAtom } from "jotai-tanstack-query";
import { toast } from "sonner";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";
import {
  listStarred,
  setStar,
  setStars,
  starScopes,
  type StarredItem,
  type StarredListing,
  type StarScope,
  type StarTarget,
} from "@/app/lib/tauri/starred";
import {
  driveStarTarget,
  resolveStarred,
  starBatchFailure,
  starBatchToast,
  starLabelOf,
  starTargetFor,
  starToast,
  targetStarKey,
} from "./starState";

import { STARRED_QUERY_KEY } from "./queryKeys";

/** The Starred listing's query key; `notifyFilesMutated` invalidates it. */
export { STARRED_QUERY_KEY };
const SCOPE_QUERY_KEY = "star-scope";

/**
 * This session's own stars, by key, for the account that set them. Read for
 * another account (or none) they are empty, so a switch never shows the last
 * account's toggles.
 */
export const starTogglesAtom = atom<{ account: string | null; toggles: Record<string, boolean> }>({
  account: null,
  toggles: {},
});

/** The signed-in account, or null where no account provider is mounted. */
function useAccount(): string | null {
  try {
    return useWalletAuth().polkadotAddress;
  } catch {
    return null;
  }
}

/** The Starred listing for this account, shared by the page and every star mark. */
export function useStarredListing() {
  const account = useAccount();
  const queryClient = useAtomValue(queryClientAtom);
  return useQuery<StarredListing>(
    {
      queryKey: [STARRED_QUERY_KEY, account],
      queryFn: () => listStarred(account as string),
      enabled: Boolean(account),
      staleTime: 60_000,
      retry: 1,
    },
    queryClient,
  );
}

/** Refresh the Starred listing (any account). */
export function invalidateStarred(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [STARRED_QUERY_KEY] });
}

function uniqueLabels(labels: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const label of labels) if (label) out.add(label);
  return [...out].sort();
}

/**
 * The star state and actions for the rows a surface shows. `labels` are the
 * drive labels on screen, so their scopes are fetched once and shared.
 */
export function useStars(labels: Iterable<string | null | undefined> = []) {
  const account = useAccount();
  const queryClient = useAtomValue(queryClientAtom);
  const [state, setState] = useAtom(starTogglesAtom);
  const toggles = useMemo(
    () => (account && state.account === account ? state.toggles : {}),
    [account, state],
  );

  // Signed out or another account: drop the last one's toggles.
  useEffect(() => {
    if (state.account !== null && state.account !== account) {
      setState({ account: null, toggles: {} });
    }
  }, [account, state.account, setState]);

  const listing = useStarredListing();
  const listedKeys = useMemo(
    () => new Set((listing.data?.items ?? []).map((item) => item.key)),
    [listing.data],
  );

  const labelKey = uniqueLabels(labels).join("\u0000");
  const labelList = useMemo(() => (labelKey ? labelKey.split("\u0000") : []), [labelKey]);
  const scopeResults = useQueries(
    {
      queries: labelList.map((label) => ({
        queryKey: [SCOPE_QUERY_KEY, account, label],
        queryFn: async (): Promise<StarScope | null> =>
          (await starScopes(account as string, [label]))[label] ?? null,
        enabled: Boolean(account),
        staleTime: Infinity,
        gcTime: 30 * 60_000,
        retry: 1,
      })),
    },
    queryClient,
  );
  // `scopeResults` is a new array every render; what matters is the data in
  // it, so the map is rebuilt only when that changes.
  const scopeSignature = scopeResults
    .map((r) => (r.data ? `${r.data.ownerSs58}|${r.data.folderHash}|${r.data.rootPath}` : ""))
    .join("\u0001");
  const scopeByLabel = useMemo(() => {
    const map = new Map<string, StarScope>();
    const parts = scopeSignature.split("\u0001");
    labelList.forEach((label, i) => {
      const part = parts[i];
      if (!part) return;
      const [ownerSs58, folderHash, ...rest] = part.split("|");
      map.set(label, { ownerSs58, folderHash, rootPath: rest.join("|") });
    });
    return map;
  }, [labelList, scopeSignature]);

  const scopeFor = useCallback(
    (label: string | null | undefined): StarScope | null => {
      if (!label) return null;
      return (
        scopeByLabel.get(label) ??
        queryClient.getQueryData<StarScope | null>([SCOPE_QUERY_KEY, account, label]) ??
        null
      );
    },
    [scopeByLabel, queryClient, account],
  );

  const keyOf = useCallback(
    (target: StarTarget): string | null => targetStarKey(target, scopeFor(target.label)),
    [scopeFor],
  );

  const starredFor = useCallback(
    (target: StarTarget, favorite?: boolean | null): boolean => {
      const key = keyOf(target);
      return resolveStarred(key ? toggles[key] : undefined, favorite, key ? listedKeys.has(key) : false);
    },
    [keyOf, toggles, listedKeys],
  );

  /** Whether a row shows as starred. */
  const isStarred = useCallback(
    (row: FormattedUserFile, basePath?: string | null): boolean => {
      const target = starTargetFor(row, basePath);
      return target ? starredFor(target, row.favorite) : false;
    },
    [starredFor],
  );

  /** Whether a whole drive shows as starred. */
  const isDriveStarred = useCallback(
    (label: string): boolean => starredFor(driveStarTarget(label, label)),
    [starredFor],
  );

  /** Whether a Starred-page item shows as starred (unless toggled off here). */
  const isItemStarred = useCallback(
    (item: StarredItem): boolean => toggles[item.key] ?? true,
    [toggles],
  );

  const writeToggles = useCallback(
    (update: (prev: Record<string, boolean>) => Record<string, boolean>) => {
      if (!account) return;
      setState((prev) => ({
        account,
        toggles: update(prev.account === account ? prev.toggles : {}),
      }));
    },
    [account, setState],
  );

  const afterChange = useCallback(async () => {
    await Promise.all([invalidateStarred(queryClient), notifyFilesMutated(queryClient, account)]);
  }, [queryClient, account]);

  /** Star or unstar one target: optimistic, rolled back on error. */
  const toggleTarget = useCallback(
    async (target: StarTarget, next: boolean, knownKey?: string | null): Promise<boolean> => {
      if (!account) return false;
      const key = knownKey ?? keyOf(target);
      const before = key ? toggles[key] : undefined;
      if (key) writeToggles((prev) => ({ ...prev, [key]: next }));
      try {
        const result = await setStar(account, target, next);
        writeToggles((prev) => {
          const out = { ...prev, [result.key]: result.favorite };
          return out;
        });
        toast.success(starToast(target.name, result.favorite));
        void afterChange();
        return true;
      } catch (error) {
        if (key) {
          writeToggles((prev) => {
            const out = { ...prev };
            if (before === undefined) delete out[key];
            else out[key] = before;
            return out;
          });
        }
        toast.error(tauriErrorMessage(error));
        return false;
      }
    },
    [account, keyOf, toggles, writeToggles, afterChange],
  );

  /** Star an unstarred row, unstar a starred one. */
  const toggleRow = useCallback(
    (row: FormattedUserFile, basePath?: string | null) => {
      const target = starTargetFor(row, basePath);
      if (!target) return Promise.resolve(false);
      return toggleTarget(target, !starredFor(target, row.favorite));
    },
    [toggleTarget, starredFor],
  );

  /** Star or unstar a whole drive by its label. */
  const toggleDrive = useCallback(
    (label: string, name: string) => {
      const target = driveStarTarget(label, name);
      return toggleTarget(target, !starredFor(target));
    },
    [toggleTarget, starredFor],
  );

  /** Unstar (or star again) an item of the Starred page. */
  const toggleItem = useCallback(
    (item: StarredItem) => {
      const target: StarTarget = {
        kind: item.kind,
        name: item.name,
        ownerSs58: item.ownerSs58,
        folderHash: item.folderHash,
        fileId: item.fileId,
        path: item.path,
      };
      return toggleTarget(target, !isItemStarred(item), item.key);
    },
    [toggleTarget, isItemStarred],
  );

  /**
   * Star the selection, or unstar it when every starrable row in it is
   * starred already. One request batch, one toast.
   */
  const toggleRows = useCallback(
    async (rows: FormattedUserFile[], basePath?: string | null): Promise<void> => {
      if (!account) return;
      const targets = rows
        .map((row) => ({ row, target: starTargetFor(row, basePath) }))
        .filter((t): t is { row: FormattedUserFile; target: StarTarget } => t.target !== null);
      if (targets.length === 0) return;
      const next = !targets.every(({ row, target }) => starredFor(target, row.favorite));
      const keys = targets.map(({ target }) => keyOf(target));
      const before = keys.map((key) => (key ? toggles[key] : undefined));
      writeToggles((prev) => {
        const out = { ...prev };
        for (const key of keys) if (key) out[key] = next;
        return out;
      });
      try {
        const result = await setStars(
          account,
          targets.map((t) => t.target),
          next,
        );
        const failedKeys = new Set(result.failed.map((f) => f.key).filter((k): k is string => Boolean(k)));
        writeToggles((prev) => {
          const out = { ...prev };
          keys.forEach((key, i) => {
            if (!key || !failedKeys.has(key)) return;
            const was = before[i];
            if (was === undefined) delete out[key];
            else out[key] = was;
          });
          for (const done of result.done) out[done.key] = done.favorite;
          return out;
        });
        if (result.failed.length === 0) {
          toast.success(starBatchToast(result.done.length, next));
        } else {
          toast.error(starBatchFailure(result.failed.length, result.done.length, next, result.full));
        }
        void afterChange();
      } catch (error) {
        writeToggles((prev) => {
          const out = { ...prev };
          keys.forEach((key, i) => {
            if (!key) return;
            const was = before[i];
            if (was === undefined) delete out[key];
            else out[key] = was;
          });
          return out;
        });
        toast.error(tauriErrorMessage(error));
      }
    },
    [account, starredFor, keyOf, toggles, writeToggles, afterChange],
  );

  /** Whether every starrable row of a selection is starred (the batch then unstars). */
  const allStarred = useCallback(
    (rows: FormattedUserFile[], basePath?: string | null): boolean => {
      const targets = rows
        .map((row) => ({ row, target: starTargetFor(row, basePath) }))
        .filter((t) => t.target !== null);
      return targets.length > 0 && targets.every(({ row, target }) => starredFor(target as StarTarget, row.favorite));
    },
    [starredFor],
  );

  return {
    account,
    isStarred,
    isDriveStarred,
    isItemStarred,
    toggleRow,
    toggleDrive,
    toggleItem,
    toggleRows,
    allStarred,
    listing,
  };
}

/** The labels of a list of rows, for `useStars`. */
export function rowLabels(rows: readonly FormattedUserFile[]): string[] {
  return uniqueLabels(rows.map(starLabelOf));
}

import { atomWithStorage } from "jotai/utils";

import {
  BROWSE_PAGE_SIZE_STORAGE_KEY,
  DEFAULT_BROWSE_PAGE_SIZE,
  normalizeBrowsePageSize,
} from "@/app/components/page-sections/drive/browsePager";

/**
 * Raw (unquoted) localStorage adapter, mirroring the theme preference's.
 * The default is stored as ABSENCE, so a fresh install carries no key and
 * going back to the default cleans the entry up. `subscribe` relays the
 * `storage` event so a change in one webview window reaches another.
 *
 * Every access is wrapped: a private window, blocked site data or a
 * thumbnail capture can make `localStorage` throw, and a drive that cannot
 * render because its page size could not be read is a far worse failure
 * than one that opens at twenty.
 */
const pageSizeStorage = {
  getItem: (key: string, initialValue: number): number => {
    if (typeof window === "undefined") return initialValue;
    try {
      return normalizeBrowsePageSize(window.localStorage.getItem(key), initialValue);
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, value: number): void => {
    try {
      if (value === DEFAULT_BROWSE_PAGE_SIZE) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, String(value));
      }
    } catch {
      // Not remembering the choice is survivable; failing the change is not.
    }
  },
  removeItem: (key: string): void => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* as above */
    }
  },
  subscribe: (key: string, callback: (value: number) => void): (() => void) => {
    if (typeof window === "undefined") return () => {};
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== key) return;
      callback(normalizeBrowsePageSize(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  },
};

/**
 * Rows per page in the drive listing, remembered across navigation and
 * restarts.
 *
 * It used to be `useState` inside `DriveContainer`, so it died the moment the
 * reader left Drive for Overview or Support: they set 50, came back, and were
 * on 20 again with no indication why.
 *
 * The PAGE NUMBER deliberately does not persist. "Which slice of this folder"
 * is about a moment, not a preference, and restoring page 4 of a folder
 * reopened later — or of a different folder entirely — is disorienting where
 * restoring the size is not.
 */
export const browsePageSizeAtom = atomWithStorage<number>(
  BROWSE_PAGE_SIZE_STORAGE_KEY,
  DEFAULT_BROWSE_PAGE_SIZE,
  pageSizeStorage,
  { getOnInit: true },
);

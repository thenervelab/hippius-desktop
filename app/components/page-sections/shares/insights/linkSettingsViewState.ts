"use client";

import { useCallback } from "react";
import { atom, useAtom } from "jotai";

/**
 * Which view an Insights panel shows for one link: its Insights, Link
 * settings, or one of Link settings' long rules (Allow list, NDA) a level
 * further in. Kept per link in app state, so closing the panel and opening
 * it again for the same link comes back to the same view.
 */
export interface LinkSettingsViewState {
  open: boolean;
  /** The rule opened inside Link settings (a `LinkRule` id), or `null`. */
  rule: string | null;
}

const CLOSED: LinkSettingsViewState = { open: false, rule: null };

/** Keyed by `fileLinkViewKey` / `folderLinkViewKey`. */
export const linkSettingsViewsAtom = atom<Readonly<Record<string, LinkSettingsViewState>>>({});

export const fileLinkViewKey = (shareToken: string) => `file:${shareToken}`;
export const folderLinkViewKey = (tokenHash: string) => `folder:${tokenHash}`;

export function useLinkSettingsView(key: string) {
  const [views, setViews] = useAtom(linkSettingsViewsAtom);
  const view = views[key] ?? CLOSED;
  const set = useCallback(
    (next: LinkSettingsViewState) =>
      setViews((all) => {
        const rest = { ...all };
        delete rest[key];
        // A closed view is the default: nothing is kept for it.
        return next.open ? { ...rest, [key]: next } : rest;
      }),
    [key, setViews],
  );
  const show = useCallback(() => set({ open: true, rule: null }), [set]);
  const hide = useCallback(() => set(CLOSED), [set]);
  const setRule = useCallback((rule: string | null) => set({ open: true, rule }), [set]);
  return { isOpen: view.open, rule: view.rule, show, hide, setRule };
}

export type LinkSettingsViewHandle = ReturnType<typeof useLinkSettingsView>;

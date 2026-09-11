"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";

import {
  pageContextActionsAtom,
  type PageContextActions,
} from "@/app/lib/global-atoms/contextMenuAtoms";

/**
 * Register what the right-click menu offers while this surface is mounted,
 * and take it away again when it unmounts.
 *
 * The clear on unmount is the load-bearing half: without it a menu opened
 * on the next page would still run the previous page's handlers, against
 * whatever folder that page had open.
 *
 * Pass a value that is stable for the surface — the effect re-registers
 * whenever `actions` changes identity, which is harmless but pointless if
 * the object is rebuilt every render.
 */
export function usePageContextActions(actions: PageContextActions) {
  const setActions = useSetAtom(pageContextActionsAtom);

  useEffect(() => {
    setActions(actions);
    return () => setActions({});
  }, [actions, setActions]);
}

export default usePageContextActions;

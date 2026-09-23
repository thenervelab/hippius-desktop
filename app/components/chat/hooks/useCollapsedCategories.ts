"use client";

import { useCallback, useEffect, useState } from "react";

import { loadCollapsedCategories, saveCollapsedCategories } from "@/lib/chat/workspace-store";

export interface CollapsedCategories {
  isCollapsed: (categoryId: string) => boolean;
  toggle: (categoryId: string) => void;
}

/**
 * Which categories of the workspace are folded in the sidebar, remembered
 * per account and workspace (localStorage). Reloaded when either changes;
 * every toggle is written through.
 */
export function useCollapsedCategories(userId: string, spaceId: string | null): CollapsedCategories {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => (spaceId ? loadCollapsedCategories(userId, spaceId) : new Set()));

  useEffect(() => {
    setCollapsed(spaceId ? loadCollapsedCategories(userId, spaceId) : new Set());
  }, [userId, spaceId]);

  const isCollapsed = useCallback((categoryId: string) => collapsed.has(categoryId), [collapsed]);
  const toggle = useCallback(
    (categoryId: string) => {
      if (!spaceId) return;
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(categoryId)) next.delete(categoryId);
        else next.add(categoryId);
        saveCollapsedCategories(userId, spaceId, next);
        return next;
      });
    },
    [userId, spaceId],
  );

  return { isCollapsed, toggle };
}

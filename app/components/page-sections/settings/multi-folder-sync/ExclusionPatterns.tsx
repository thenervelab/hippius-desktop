"use client";

import React, { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, X, Filter, Plus } from "lucide-react";
import cn from "@/lib/utils/cn";

interface ExclusionPatternsProps {
  label: string;
}

/**
 * Per-drive exclusion pattern manager.
 * Collapsible section that lists glob patterns used to exclude
 * files/directories from sync. Patterns are stored in the
 * `.hippius/{label}/exclude` file managed by hcfs-client.
 */
export function ExclusionPatterns({ label }: ExclusionPatternsProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const loadPatterns = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await invoke<string[]>(
        "list_exclude_patterns",
        { label }
      );
      setPatterns(result);
    } catch (error) {
      console.error("Failed to load exclusion patterns:", error);
      setPatterns([]);
    } finally {
      setIsLoading(false);
    }
  }, [label]);

  const handleToggle = useCallback(() => {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next) {
      loadPatterns();
    }
  }, [isExpanded, loadPatterns]);

  const handleAdd = useCallback(async () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;

    setHint(null);
    try {
      const added = await invoke<boolean>(
        "add_exclude_pattern",
        { label, pattern: trimmed }
      );
      if (!added) {
        setHint("Pattern already exists");
        return;
      }
      setNewPattern("");
      await loadPatterns();
    } catch (error) {
      console.error("Failed to add exclusion pattern:", error);
      setHint("Failed to add pattern");
    }
  }, [label, newPattern, loadPatterns]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleAdd();
      }
    },
    [handleAdd]
  );

  const handleRemove = useCallback(
    async (pattern: string) => {
      try {
        await invoke<boolean>(
          "remove_exclude_pattern",
          { label, pattern }
        );
        await loadPatterns();
      } catch (error) {
        console.error("Failed to remove exclusion pattern:", error);
      }
    },
    [label, loadPatterns]
  );

  return (
    <div className="mt-3 border-t border-grey-80 pt-3">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs font-medium text-grey-50 hover:text-grey-30 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <Filter className="size-3.5" />
        <span>Exclusion Patterns</span>
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newPattern}
              onChange={(e) => {
                setNewPattern(e.target.value);
                setHint(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="e.g. *.tmp, node_modules/"
              className="flex-1 text-xs px-2.5 py-1.5 border border-grey-80 rounded-md bg-white text-grey-20 placeholder:text-grey-60 focus:outline-none focus:ring-1 focus:ring-primary-50 focus:border-primary-50"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newPattern.trim()}
              className={cn(
                "flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-md border transition-colors",
                newPattern.trim()
                  ? "border-primary-50 text-primary-50 hover:bg-primary-95"
                  : "border-grey-80 text-grey-60 cursor-not-allowed"
              )}
            >
              <Plus className="size-3" />
              Add
            </button>
          </div>

          {hint && (
            <p className="text-xs text-warning-50">{hint}</p>
          )}

          <p className="text-xs text-grey-60">
            {"Use trailing / for directories (e.g. node_modules/)"}
          </p>

          {isLoading ? (
            <div className="flex justify-center py-3">
              <div className="size-4 border-2 border-grey-80 border-t-primary-50 rounded-full animate-spin" />
            </div>
          ) : patterns.length === 0 ? (
            <p className="text-xs text-grey-60 italic py-2">
              All files are synced
            </p>
          ) : (
            <div className="space-y-1">
              {patterns.map((pattern) => (
                <div
                  key={pattern}
                  className="flex items-center justify-between px-2.5 py-1.5 bg-grey-98 border border-grey-80 rounded-md group"
                >
                  <span className="text-xs text-grey-30 font-mono">
                    {pattern}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemove(pattern)}
                    className="text-grey-60 hover:text-error-50 transition-colors opacity-0 group-hover:opacity-100"
                    title="Remove pattern"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

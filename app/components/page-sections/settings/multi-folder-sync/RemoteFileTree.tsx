"use client";

import React, { useState, useCallback, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  File,
  Download,
  MoreVertical,
} from "lucide-react";
import { formatBytes } from "@/lib/utils/formatBytes";
import TableActionMenu, {
  ActionItem,
} from "@/components/ui/alt-table/TableActionMenu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Button } from "@/components/ui/button";
import cn from "@/lib/utils/cn";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RemoteFileInfo {
  file_id: string;
  path: string;
  name: string;
  size_bytes: number;
  arion_hash: string | null;
  created_at: number;
  updated_at: number;
}

/** Virtual tree node built from the flat file list. */
interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  size_bytes: number;
  children: TreeNode[];
  /** Only set on leaf (file) nodes. */
  file?: RemoteFileInfo;
}

// ─── Tree builder ───────────────────────────────────────────────────────────

function buildTree(files: RemoteFileInfo[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isFolder: true,
    size_bytes: 0,
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join("/");

      if (isLast) {
        // Leaf file node
        current.children.push({
          name: part,
          path: partPath,
          isFolder: false,
          size_bytes: file.size_bytes,
          children: [],
          file,
        });
      } else {
        // Find or create intermediate folder
        let folder = current.children.find(
          (c) => c.isFolder && c.name === part
        );
        if (!folder) {
          folder = {
            name: part,
            path: partPath,
            isFolder: true,
            size_bytes: 0,
            children: [],
          };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  // Compute aggregate sizes for folders
  function computeSize(node: TreeNode): number {
    if (!node.isFolder) return node.size_bytes;
    node.size_bytes = node.children.reduce(
      (sum, c) => sum + computeSize(c),
      0
    );
    return node.size_bytes;
  }

  // Sort: folders first, then alphabetical
  function sortChildren(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  }

  root.children.forEach(computeSize);
  sortChildren(root);
  return root.children;
}

// ─── Checkbox state helpers ─────────────────────────────────────────────────

type CheckState = "checked" | "unchecked" | "indeterminate";

function getCheckState(
  node: TreeNode,
  selected: Set<string>
): CheckState {
  if (!node.isFolder) {
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const leaves = getAllLeaves(node);
  const checkedCount = leaves.filter((l) => selected.has(l.path)).length;
  if (checkedCount === 0) return "unchecked";
  if (checkedCount === leaves.length) return "checked";
  return "indeterminate";
}

function getAllLeaves(node: TreeNode): TreeNode[] {
  if (!node.isFolder) return [node];
  return node.children.flatMap(getAllLeaves);
}

// ─── TriStateCheckbox ───────────────────────────────────────────────────────

function TriStateCheckbox({
  state,
  onChange,
  disabled,
}: {
  state: CheckState;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      disabled={disabled}
      className={cn(
        "size-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors",
        state === "checked"
          ? "bg-primary-50 border-primary-50"
          : state === "indeterminate"
            ? "bg-primary-50 border-primary-50"
            : "border-grey-60 hover:border-primary-50",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      {state === "checked" && (
        <svg
          viewBox="0 0 12 12"
          className="size-3 text-white"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M2 6l3 3 5-5" />
        </svg>
      )}
      {state === "indeterminate" && (
        <div className="w-2 h-0.5 bg-white rounded-full" />
      )}
    </button>
  );
}

// ─── TreeRow ────────────────────────────────────────────────────────────────

function TreeRow({
  node,
  depth,
  selected,
  onToggle,
  expanded,
  onExpand,
  onDownload,
}: {
  node: TreeNode;
  depth: number;
  selected: Set<string>;
  onToggle: (node: TreeNode) => void;
  expanded: Set<string>;
  onExpand: (path: string) => void;
  onDownload: (file: RemoteFileInfo) => void;
}) {
  const checkState = getCheckState(node, selected);
  const isExpanded = expanded.has(node.path);

  const fileActions: ActionItem[] = node.file
    ? [
        {
          icon: <Download className="size-3.5" />,
          itemTitle: "Download",
          onItemClick: () => onDownload(node.file!),
        },
      ]
    : [];

  const childCount = node.isFolder
    ? getAllLeaves(node).length
    : 0;

  return (
    <>
      <div
        className="flex items-center gap-1.5 py-1 px-2 hover:bg-grey-98 rounded group transition-colors"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* Expand/collapse toggle for folders */}
        {node.isFolder ? (
          <button
            type="button"
            onClick={() => onExpand(node.path)}
            className="p-0.5 text-grey-50 hover:text-grey-30 flex-shrink-0"
          >
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="w-[18px]" />
        )}

        <TriStateCheckbox
          state={checkState}
          onChange={() => onToggle(node)}
        />

        {node.isFolder ? (
          <Folder className="size-4 text-primary-50 flex-shrink-0" />
        ) : (
          <File className="size-4 text-grey-50 flex-shrink-0" />
        )}

        <Tooltip.Provider delayDuration={200}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className="text-sm text-grey-20 truncate flex-1 min-w-0 cursor-default">
                {node.name}
                {node.isFolder && "/"}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="bottom"
                className="z-[9999] max-w-[400px] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
                sideOffset={4}
              >
                {node.name}
                <Tooltip.Arrow className="fill-white" width={12} height={6} />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>

        <span className="text-xs text-grey-60 flex-shrink-0 tabular-nums">
          {node.isFolder
            ? `${childCount} ${childCount === 1 ? "file" : "files"}`
            : formatBytes(node.size_bytes)}
        </span>

        {/* 3-dot menu for files */}
        {!node.isFolder && node.file && (
          <TableActionMenu
            dropdownTitle=""
            items={fileActions}
          >
            <Button
              variant="ghost"
              size="md"
              className="h-6 w-6 p-0 text-grey-60 opacity-0 group-hover:opacity-100 transition-opacity action-menu-area"
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </TableActionMenu>
        )}
      </div>

      {/* Render children if expanded */}
      {node.isFolder &&
        isExpanded &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            selected={selected}
            onToggle={onToggle}
            expanded={expanded}
            onExpand={onExpand}
            onDownload={onDownload}
          />
        ))}
    </>
  );
}

// ─── RemoteFileTree (exported) ──────────────────────────────────────────────

interface RemoteFileTreeProps {
  files: RemoteFileInfo[];
  selected: Set<string>;
  onSelectedChange: (selected: Set<string>) => void;
  onDownload: (file: RemoteFileInfo) => void;
  filter: string;
}

export function RemoteFileTree({
  files,
  selected,
  onSelectedChange,
  onDownload,
  filter,
}: RemoteFileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildTree(files), [files]);

  // Filter tree nodes by name (case-insensitive)
  const filteredTree = useMemo(() => {
    if (!filter.trim()) return tree;
    const lowerFilter = filter.toLowerCase();

    function filterNode(node: TreeNode): TreeNode | null {
      if (!node.isFolder) {
        return node.name.toLowerCase().includes(lowerFilter) ? node : null;
      }
      const filteredChildren = node.children
        .map(filterNode)
        .filter(Boolean) as TreeNode[];
      if (filteredChildren.length === 0) return null;
      return { ...node, children: filteredChildren };
    }

    return tree.map(filterNode).filter(Boolean) as TreeNode[];
  }, [tree, filter]);

  // Auto-expand all folders when filtering
  const effectiveExpanded = useMemo(() => {
    if (!filter.trim()) return expanded;
    const all = new Set<string>();
    function collectFolders(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.isFolder) {
          all.add(n.path);
          collectFolders(n.children);
        }
      }
    }
    collectFolders(filteredTree);
    return all;
  }, [filter, expanded, filteredTree]);

  const handleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleToggle = useCallback(
    (node: TreeNode) => {
      const next = new Set(selected);
      const leaves = getAllLeaves(node);
      const allChecked = leaves.every((l) => next.has(l.path));

      if (allChecked) {
        // Uncheck all
        for (const l of leaves) next.delete(l.path);
      } else {
        // Check all
        for (const l of leaves) next.add(l.path);
      }
      onSelectedChange(next);
    },
    [selected, onSelectedChange]
  );

  if (filteredTree.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-grey-60">
        {filter.trim()
          ? "No files match your filter"
          : "This folder is empty"}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {filteredTree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          onToggle={handleToggle}
          expanded={effectiveExpanded}
          onExpand={handleExpand}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

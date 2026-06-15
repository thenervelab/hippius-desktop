"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Checkbox from "@radix-ui/react-checkbox";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  X,
  ChevronRight,
  Folder as FolderIcon,
  File as FileIcon,
} from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";

import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { Button, SearchInput, FormattedTimestamp, Skeleton, Graphsheet } from "@/components/ui";
import { Database } from "lucide-react";
import * as TableModule from "@/components/ui/alt-table";
import { formatBytes } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import {
  getFileTypeFromExtension,
  getFileTypeDisplayLabel,
} from "@/lib/utils/getTileTypeFromExtension";
import { cn } from "@/lib/utils";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";

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

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  size_bytes: number;
  timestamp: number;
  typeLabel: string;
  children: TreeNode[];
  file?: RemoteFileInfo;
}

interface RemoteFolderBrowserProps {
  open: boolean;
  onClose: () => void;
  folder: RemoteFolder;
  accountId: string;
  /** Remote folders: passes excluded paths to the parent restore flow. */
  onSyncSelected: (folder: RemoteFolder, excludedPaths: string[]) => void;
  /** When true, the folder is already synced locally — apply exclusion patterns directly. */
  isLocal?: boolean;
}

// ─── Tree helpers ───────────────────────────────────────────────────────────

function buildTree(files: RemoteFileInfo[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isFolder: true,
    size_bytes: 0,
    timestamp: 0,
    typeLabel: "Folder",
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
        const { fileFormat } = getFilePartsFromFileName(part);
        const fileType = getFileTypeFromExtension(fileFormat || null);
        current.children.push({
          name: part,
          path: partPath,
          isFolder: false,
          size_bytes: file.size_bytes,
          timestamp: file.created_at,
          typeLabel: getFileTypeDisplayLabel(fileType),
          children: [],
          file,
        });
      } else {
        let folder = current.children.find(
          (c) => c.isFolder && c.name === part
        );
        if (!folder) {
          folder = {
            name: part,
            path: partPath,
            isFolder: true,
            size_bytes: 0,
            timestamp: 0,
            typeLabel: "Folder",
            children: [],
          };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  function aggregate(node: TreeNode): { size: number; ts: number } {
    if (!node.isFolder) return { size: node.size_bytes, ts: node.timestamp };
    let size = 0;
    let ts = 0;
    for (const child of node.children) {
      const c = aggregate(child);
      size += c.size;
      if (c.ts > ts) ts = c.ts;
    }
    node.size_bytes = size;
    node.timestamp = ts;
    return { size, ts };
  }

  function sortChildren(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  }

  root.children.forEach(aggregate);
  sortChildren(root);
  return root.children;
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  let current: TreeNode | null = null;
  let pool = nodes;
  for (const part of parts) {
    current = pool.find((n) => n.isFolder && n.name === part) ?? null;
    if (!current) return null;
    pool = current.children;
  }
  return current;
}

function getAllLeaves(node: TreeNode): TreeNode[] {
  if (!node.isFolder) return [node];
  return node.children.flatMap(getAllLeaves);
}

type CheckState = "checked" | "unchecked" | "indeterminate";

function getNodeCheckState(node: TreeNode, selected: Set<string>): CheckState {
  if (!node.isFolder) {
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const leaves = getAllLeaves(node);
  if (leaves.length === 0) return "unchecked";
  const checkedCount = leaves.filter((l) => selected.has(l.path)).length;
  if (checkedCount === 0) return "unchecked";
  if (checkedCount === leaves.length) return "checked";
  return "indeterminate";
}

// ─── Checkbox — identical to NotificationsSettingsDialog ───────────────────

function BrowserCheckbox({
  state,
  onChange,
  disabled,
  ariaLabel,
}: {
  state: CheckState;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const radixChecked: boolean | "indeterminate" =
    state === "indeterminate" ? "indeterminate" : state === "checked";
  return (
    <Checkbox.Root
      aria-label={ariaLabel}
      checked={radixChecked}
      onCheckedChange={onChange}
      onClick={(e) => e.stopPropagation()}
      disabled={disabled}
      className={cn(
        "size-4 rounded border border-grey-70 dark:border-[#555555]",
        "flex items-center justify-center bg-white dark:bg-black-300",
        "data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50",
        "data-[state=indeterminate]:bg-primary-50 data-[state=indeterminate]:border-primary-50",
        "dark:data-[state=checked]:bg-primary-brand-dark dark:data-[state=checked]:border-primary-brand-dark",
        "dark:data-[state=indeterminate]:bg-primary-brand-dark dark:data-[state=indeterminate]:border-primary-brand-dark",
        "shrink-0 transition-colors",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      {/* Indicator only renders a glyph for the indeterminate state — the
          checked state is conveyed by the solid blue background alone, to
          match the notification settings checkboxes. */}
      <Checkbox.Indicator>
        {state === "indeterminate" && (
          <span className="block w-2 h-0.5 bg-white rounded-full" />
        )}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

const columnHelper = createColumnHelper<TreeNode>();

// Pixel widths used in <colgroup>. Total ≈ 700px; inner card ≈ 565px,
// so Name + Size are visible without scroll, Date + Type scroll into view.
const COL_WIDTH = {
  name: 280,
  size: 100,
  date_uploaded: 200,
  type: 120,
} as const;

export function RemoteFolderBrowser({
  open,
  onClose,
  folder,
  accountId,
  onSyncSelected,
  isLocal = false,
}: RemoteFolderBrowserProps) {
  const [files, setFiles] = useState<RemoteFileInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [sorting, setSorting] = useState<SortingState>([]);

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setSelected(new Set());
    setFilter("");
    setError(null);
    setCurrentPath("");
    setSorting([]);

    let cancelled = false;
    setIsLoading(true);

    const fetchFiles = invoke<RemoteFileInfo[]>("list_remote_folder_files", {
      accountId,
      label: folder.folderName,
    });

    const fetchExclusions = isLocal
      ? invoke<string[]>("list_exclude_patterns", { label: folder.folderName })
      : Promise.resolve([]);

    Promise.all([fetchFiles, fetchExclusions])
      .then(([result, exclusions]) => {
        if (cancelled) return;
        setFiles(result);
        const excludedSet = new Set(exclusions);
        const initialSelected = new Set(
          result.map((f) => f.path).filter((p) => !excludedSet.has(p))
        );
        setSelected(initialSelected);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to list remote files:", err);
        setError(
          typeof err === "string" ? err : "Failed to load remote files"
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, accountId, folder.folderName, isLocal]);

  // ── Derived data ───────────────────────────────────────────────────────

  const tree = useMemo(() => buildTree(files), [files]);

  const allPaths = useMemo(
    () => new Set(files.map((f) => f.path)),
    [files]
  );

  const currentFolderNode = useMemo(() => {
    if (!currentPath) {
      return {
        name: folder.folderName,
        path: "",
        isFolder: true,
        size_bytes: 0,
        timestamp: 0,
        typeLabel: "Folder",
        children: tree,
      } as TreeNode;
    }
    return findNode(tree, currentPath);
  }, [tree, currentPath, folder.folderName]);

  const visibleEntries = useMemo(() => {
    const entries = currentFolderNode?.children ?? [];
    if (!filter.trim()) return entries;
    const lower = filter.toLowerCase();
    return entries.filter((n) => n.name.toLowerCase().includes(lower));
  }, [currentFolderNode, filter]);

  const selectedCount = selected.size;
  const totalCount = files.length;
  const selectedSize = useMemo(
    () =>
      files
        .filter((f) => selected.has(f.path))
        .reduce((sum, f) => sum + f.size_bytes, 0),
    [files, selected]
  );

  const breadcrumbSegments = useMemo(() => {
    if (!currentPath) return [] as { name: string; path: string }[];
    const parts = currentPath.split("/").filter(Boolean);
    return parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join("/"),
    }));
  }, [currentPath]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleSelectAll = useCallback(() => {
    setSelected(new Set(allPaths));
  }, [allPaths]);

  const handleDeselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleToggleNode = useCallback((node: TreeNode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const leaves = getAllLeaves(node);
      const allChecked =
        leaves.length > 0 && leaves.every((l) => next.has(l.path));
      if (allChecked) {
        for (const l of leaves) next.delete(l.path);
      } else {
        for (const l of leaves) next.add(l.path);
      }
      return next;
    });
  }, []);

  const handleEnterFolder = useCallback((node: TreeNode) => {
    if (!node.isFolder) return;
    setCurrentPath(node.path);
    setFilter("");
  }, []);

  const handleBreadcrumbClick = useCallback((path: string) => {
    setCurrentPath(path);
    setFilter("");
  }, []);

  const handleSyncSelected = useCallback(async () => {
    if (isLocal) {
      setIsApplying(true);
      try {
        const excludedPaths = files
          .filter((f) => !selected.has(f.path))
          .map((f) => f.path);
        const includedPaths = files
          .filter((f) => selected.has(f.path))
          .map((f) => f.path);

        await invoke("apply_sync_selection", {
          label: folder.folderName,
          include: includedPaths,
          exclude: excludedPaths,
        });

        toast.success("Sync selection updated");
        onClose();
      } catch (err) {
        console.error("Failed to apply selection:", err);
        toast.error("Failed to update sync selection");
      } finally {
        setIsApplying(false);
      }
    } else {
      const excludedPaths = files
        .filter((f) => !selected.has(f.path))
        .map((f) => f.path);
      onSyncSelected(folder, excludedPaths);
    }
  }, [files, selected, folder, onSyncSelected, isLocal, onClose]);

  const handleClose = useCallback(() => {
    if (isApplying) return;
    onClose();
  }, [isApplying, onClose]);

  // ── Columns (TanStack) — checkbox lives inside Name cell ──────────────

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        id: "name",
        header: "Name",
        enableSorting: true,
        sortingFn: (a, b) => {
          if (a.original.isFolder !== b.original.isFolder) {
            return a.original.isFolder ? -1 : 1;
          }
          return a.original.name.localeCompare(b.original.name);
        },
        cell: ({ row }) => {
          const node = row.original;
          const state = getNodeCheckState(node, selected);
          return (
            <div className="flex items-center gap-2 min-w-0">
              <BrowserCheckbox
                state={state}
                onChange={() => handleToggleNode(node)}
                ariaLabel={`Select ${node.name}`}
              />
              {node.isFolder ? (
                <FolderIcon className="size-4 text-primary-50 shrink-0" />
              ) : (
                <FileIcon className="size-4 text-grey-50 dark:text-grey-dark-600 shrink-0" />
              )}
              <span
                className={cn(
                  "text-xs font-medium truncate tracking-[-0.24px]",
                  "text-grey-dark-800 dark:text-white"
                )}
                title={node.name}
              >
                {node.name}
              </span>
            </div>
          );
        },
      }),
      columnHelper.accessor("size_bytes", {
        id: "size",
        header: "Size",
        enableSorting: true,
        cell: ({ getValue }) => {
          const value = getValue();
          return (
            <div className="text-grey-dark-800 dark:text-grey-dark-300 text-xs font-medium truncate tracking-[-0.24px]">
              {value > 0 ? formatBytes(value) : "—"}
            </div>
          );
        },
      }),
      columnHelper.accessor("timestamp", {
        id: "date_uploaded",
        header: "Date Uploaded",
        enableSorting: true,
        cell: ({ getValue }) => {
          const ts = getValue();
          if (!ts) {
            return (
              <div className="truncate text-grey-dark-800 dark:text-grey-dark-300 text-xs">
                —
              </div>
            );
          }
          return (
            <div className="truncate">
              <FormattedTimestamp
                timestamp={ts}
                className="text-grey-dark-800 dark:text-grey-dark-300 text-xs font-medium tracking-[-0.24px]"
              />
            </div>
          );
        },
      }),
      columnHelper.accessor("typeLabel", {
        id: "type",
        header: "File Type",
        enableSorting: true,
        cell: ({ getValue }) => (
          <div className="text-grey-dark-800 dark:text-grey-dark-300 text-xs font-medium truncate tracking-[-0.24px]">
            {getValue()}
          </div>
        ),
      }),
    ],
    [selected, handleToggleNode]
  );

  const table = useReactTable({
    data: visibleEntries,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualSorting: false,
    enableRowSelection: false,
    enableMultiRowSelection: false,
  });

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-white/[0.4] backdrop-blur-[20px] dark:bg-[rgba(4,4,4,0.2)] dark:backdrop-blur-[20px]" />

        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-0 left-0 right-0 h-screen z-[61] flex items-center justify-center p-3 sm:p-6"
          onClick={handleClose}
        >
          {/* max-w-[741px] on the outer container yields a ~565px inner
              white card (sm: 60px outer pad + 16px gray ring + 12px blue
              frame, each side). */}
          <BackgroundContainer
            className="w-full max-w-[741px]"
            fillClassName="fill-[#f9f9f9] dark:fill-[#262626]"
            hippoIconClassName="fill-[#989898] dark:fill-[#5e5e5e]"
            contentClassName="flex justify-center"
            shellClassName="w-full min-w-0 max-w-[741px]"
            cardClassName="w-full min-w-0 max-w-full gap-0 p-0"
            stopClickPropagation
            addDotWithBlurryEffect
            isDialog
          >
            <div className="relative w-full p-4 sm:p-5 flex flex-col gap-4">
              {/* Top row: selection summary + close */}
              <div className="flex items-center justify-between gap-3">
                <Dialog.Title className="font-geist text-[14px] font-medium text-grey-10 dark:text-white">
                  {selectedCount}/{totalCount} files selected
                  {selectedSize > 0 && (
                    <span className="text-[#7D7D7D] dark:text-grey-dark-600">
                      {" "}
                      ({formatBytes(selectedSize)})
                    </span>
                  )}
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close"
                    className="text-[#0a0a0a] hover:text-[#737373] dark:text-white dark:hover:text-[#a3a3a3] transition-colors"
                  >
                    <X className="size-5" />
                  </button>
                </Dialog.Close>
              </div>

              {/* SettingsCard-style container */}
              <div
                className={cn(
                  "rounded-[8px] border overflow-hidden",
                  "bg-grey-light-300 border-grey-dark-100",
                  "dark:bg-black-primary-bg dark:border-black-300",
                  "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]"
                )}
              >
                {/* Header strip — fixed 46px so a deeply nested breadcrumb
                    doesn't grow the dialog. Breadcrumb segments truncate
                    individually; the whole nav line itself is allowed to
                    scroll horizontally as a last resort if every segment
                    is at its max-w and still overflows. */}
                <div
                  className={cn(
                    "grid items-center gap-3 px-[12px] h-[46px]",
                    "grid-cols-[minmax(0,1fr)_auto]"
                  )}
                >
                  <nav
                    aria-label="Folder path"
                    className={cn(
                      "flex items-center gap-x-1 min-w-0 select-none",
                      "overflow-x-auto overflow-y-hidden no-scrollbar"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleBreadcrumbClick("")}
                      className={cn(
                        "font-geist text-[14px] font-medium tracking-[-0.28px] whitespace-nowrap transition-opacity",
                        currentPath
                          ? "text-grey-10 dark:text-grey-light-200 opacity-40 hover:opacity-100 cursor-pointer"
                          : "text-grey-10 dark:text-grey-light-200"
                      )}
                    >
                      {folder.folderName}
                    </button>
                    {breadcrumbSegments.map((seg, i) => {
                      const isLast = i === breadcrumbSegments.length - 1;
                      return (
                        <React.Fragment key={seg.path}>
                          <ChevronRight className="size-[14px] text-grey-10 dark:text-grey-light-200 opacity-40 shrink-0" />
                          <button
                            type="button"
                            onClick={() =>
                              !isLast && handleBreadcrumbClick(seg.path)
                            }
                            className={cn(
                              "font-geist text-[14px] font-medium tracking-[-0.28px] whitespace-nowrap transition-opacity truncate max-w-[200px]",
                              isLast
                                ? "text-grey-10 dark:text-grey-light-200"
                                : "text-grey-10 dark:text-grey-light-200 opacity-40 hover:opacity-100 cursor-pointer"
                            )}
                            title={seg.name}
                          >
                            {seg.name}
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </nav>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="defaultStable"
                      size="auto"
                      onClick={handleDeselectAll}
                      disabled={selectedCount === 0}
                      className={cn(
                        "h-[30px] gap-[7px] rounded-[6px] border px-3 text-[13px] font-normal leading-[1.109] tracking-[-0.26px]",
                        "border-grey-dark-100 bg-[#FEFEFE] text-[#111]",
                        "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
                        "hover:bg-[#F5F5F5]",
                        "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-300 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
                      )}
                    >
                      Deselect All
                    </Button>
                    <Button
                      variant="defaultStable"
                      size="auto"
                      onClick={handleSelectAll}
                      disabled={selectedCount === totalCount}
                      className={cn(
                        "h-[30px] gap-[7px] rounded-[6px] border px-3 text-[13px] font-normal leading-[1.109] tracking-[-0.26px]",
                        "border-grey-dark-100 bg-[#FEFEFE] text-[#111]",
                        "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
                        "hover:bg-[#F5F5F5]",
                        "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-300 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
                      )}
                    >
                      Select All
                    </Button>
                  </div>
                </div>

                {/* Body — rounded-top + border-top divide it from the
                    header strip, matching the SettingsCard pattern used
                    across all settings sections. Body height is locked
                    (search row 56px + table area 336px = 392px) so the
                    dialog never reflows with row count, filter results,
                    or folder navigation. */}
                <div
                  style={{ height: 392 }}
                  className={cn(
                    "rounded-tl-[8px] rounded-tr-[8px] border-t bg-white",
                    "border-grey-dark-100 dark:bg-black-600 dark:border-black-300"
                  )}
                >
                  {/* Search row: right-aligned 207px, fixed 56px height */}
                  <div
                    style={{ height: 56 }}
                    className="px-3 flex items-center justify-end"
                  >
                    <div className="w-[207px]">
                      <SearchInput
                        value={filter}
                        onChange={setFilter}
                        placeholder="Search files"
                      />
                    </div>
                  </div>

                  {/* Table area — flush with the body edges, no outer
                      border or rounded wrapper. Cells get extra padding
                      on the first/last column so content has breathing
                      room from the card edges. */}
                  {isLoading ? (
                    <div
                      style={{ height: 336 }}
                      className={cn(
                        "overflow-hidden",
                        "[&::-webkit-scrollbar-corner]:bg-transparent"
                      )}
                    >
                      <table className="w-full table-fixed border-collapse">
                        <colgroup>
                          <col style={{ width: COL_WIDTH.name }} />
                          <col style={{ width: COL_WIDTH.size }} />
                          <col style={{ width: COL_WIDTH.date_uploaded }} />
                          <col style={{ width: COL_WIDTH.type }} />
                        </colgroup>
                        <TableModule.THead>
                          <TableModule.Tr className="border-b-grey-dark-100">
                            {[
                              { id: "name", label: "Name" },
                              { id: "size", label: "Size" },
                              { id: "date", label: "Date Uploaded" },
                              { id: "type", label: "File Type" },
                            ].map((col) => (
                              <th
                                key={col.id}
                                className={cn(
                                  "h-8 px-2 py-2 first:pl-4 last:pr-4 text-left",
                                  "border-t border-x-0 border-r last:border-r-0 border-grey-dark-100",
                                  "text-grey-dark-600 bg-grey-light-300",
                                  "dark:bg-black-600 dark:border-black-300",
                                  "text-xs font-semibold"
                                )}
                              >
                                {col.label}
                              </th>
                            ))}
                          </TableModule.Tr>
                        </TableModule.THead>
                        <TableModule.TBody>
                          {Array.from({ length: 6 }).map((_, i) => (
                            <TableModule.Tr
                              key={`skeleton-${i}`}
                              transparent
                              className={cn(
                                "border-b-0",
                                "odd:bg-white even:bg-grey-light-200",
                                "dark:odd:bg-black-600 dark:even:bg-black-primary-bg"
                              )}
                            >
                              {/* Name */}
                              <td className="px-2 py-[5px] first:pl-4 border-x-0 border-r border-grey-dark-100 dark:border-black-300">
                                <div className="flex items-center gap-2 min-w-0">
                                  <Skeleton width={16} height={16} />
                                  <Skeleton width={16} height={16} />
                                  <Skeleton width={140} height={12} />
                                </div>
                              </td>
                              {/* Size */}
                              <td className="px-2 py-[5px] border-x-0 border-r border-grey-dark-100 dark:border-black-300">
                                <Skeleton width={56} height={12} />
                              </td>
                              {/* Date Uploaded */}
                              <td className="px-2 py-[5px] border-x-0 border-r border-grey-dark-100 dark:border-black-300">
                                <Skeleton width={120} height={12} />
                              </td>
                              {/* File Type */}
                              <td className="px-2 py-[5px] last:pr-4 border-x-0 border-grey-dark-100 dark:border-black-300">
                                <Skeleton width={72} height={12} />
                              </td>
                            </TableModule.Tr>
                          ))}
                        </TableModule.TBody>
                      </table>
                    </div>
                  ) : error ? (
                    <div
                      style={{ height: 336 }}
                      className="flex flex-col items-center justify-center px-6 text-center gap-2"
                    >
                      <p className="text-sm text-error-50">{error}</p>
                      <button
                        type="button"
                        className="text-xs text-primary-50 hover:underline"
                        onClick={onClose}
                      >
                        Close and try again
                      </button>
                    </div>
                  ) : visibleEntries.length === 0 ? (
                    <div
                      style={{ height: 336 }}
                      className="flex flex-col items-center justify-center px-6 text-center"
                    >
                      {/* Graphsheet badge — mirrors the drive page's
                          NoMatchingResults empty state. */}
                      <div className="flex items-center justify-center h-[56px] w-[56px] relative mb-4">
                        <Graphsheet
                          majorCell={{
                            lineColor: [31, 80, 189, 1],
                            lineWidth: 2,
                            cellDim: 40,
                          }}
                          minorCell={{
                            lineColor: [31, 80, 189, 1],
                            lineWidth: 2,
                            cellDim: 40,
                          }}
                          className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-30"
                        />
                        <div className="bg-white-cloud-gradient-sm absolute w-full h-full" />
                        <div className="flex items-center justify-center h-8 w-8 bg-primary-50 rounded-[0.5rem] relative">
                          <Database className="size-5 text-white" />
                        </div>
                      </div>
                      <span className="text-[18px] font-medium text-grey-10 dark:text-white mb-2">
                        {filter.trim()
                          ? "No matching results"
                          : "This folder is empty"}
                      </span>
                      <p className="text-[13px] text-grey-60 dark:text-grey-dark-700 max-w-[280px]">
                        {filter.trim()
                          ? `No files found matching "${filter.trim()}". Try a different search term.`
                          : "There are no files in this folder yet."}
                      </p>
                    </div>
                  ) : (
                    <div
                      style={{ height: 336 }}
                      className={cn(
                        // Horizontal scroll is silent: cut-off columns
                        // are the affordance, users scroll via trackpad
                        // swipe or shift+wheel. The native horizontal
                        // scrollbar is suppressed by the no-scrollbar-x
                        // arbitrary variant below. Vertical stays thin
                        // and visible when content overflows.
                        "overflow-x-auto overflow-y-auto custom-scrollbar-thin",
                        "[&::-webkit-scrollbar-corner]:bg-transparent",
                        "[&::-webkit-scrollbar:horizontal]:hidden",
                        "[scrollbar-width:thin]"
                      )}
                    >
                      <table className="w-full table-fixed border-collapse">
                        <colgroup>
                          <col style={{ width: COL_WIDTH.name }} />
                          <col style={{ width: COL_WIDTH.size }} />
                          <col style={{ width: COL_WIDTH.date_uploaded }} />
                          <col style={{ width: COL_WIDTH.type }} />
                        </colgroup>
                        <TableModule.THead>
                          {table.getHeaderGroups().map((headerGroup) => (
                            <TableModule.Tr
                              key={headerGroup.id}
                              className="border-b-grey-dark-100"
                            >
                              {headerGroup.headers.map((header) => (
                                <TableModule.Th
                                  key={header.id}
                                  header={header}
                                  align="left"
                                  disableResize
                                  disableUppercase
                                  className={cn(
                                    "h-8 px-2 py-2 first:pl-4 last:pr-4",
                                    "border-t border-x-0 border-r last:border-r-0 border-grey-dark-100",
                                    "text-grey-dark-600 bg-grey-light-300",
                                    "dark:bg-black-600 dark:border-black-300 dark:hover:bg-black-400"
                                  )}
                                />
                              ))}
                            </TableModule.Tr>
                          ))}
                        </TableModule.THead>
                        <TableModule.TBody>
                          {table.getRowModel().rows.map((row) => {
                            const node = row.original;
                            return (
                              <TableModule.Tr
                                key={row.id}
                                transparent
                                className={cn(
                                  "border-b-0",
                                  "odd:bg-white even:bg-grey-light-200 hover:bg-grey-light-300",
                                  "dark:odd:bg-black-600 dark:even:bg-black-primary-bg dark:hover:bg-black-300",
                                  node.isFolder && "cursor-pointer"
                                )}
                                onClick={(e) => {
                                  const target = e.target as HTMLElement;
                                  if (
                                    target.closest('[role="checkbox"]') ||
                                    target.closest(".checkbox-container")
                                  ) {
                                    return;
                                  }
                                  if (node.isFolder) handleEnterFolder(node);
                                }}
                              >
                                {row.getVisibleCells().map((cell) => (
                                  <TableModule.Td
                                    key={cell.id}
                                    cell={cell}
                                    className={cn(
                                      "px-2 py-[5px] first:pl-4 last:pr-4",
                                      "border-x-0 border-r last:border-r-0 border-grey-dark-100",
                                      "text-grey-dark-800 text-xs dark:border-black-300"
                                    )}
                                  />
                                ))}
                              </TableModule.Tr>
                            );
                          })}
                        </TableModule.TBody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Footer buttons — Cancel + Sync, equal width, 32px tall */}
              <div className="flex items-center gap-3">
                <Button
                  variant="defaultStable"
                  size="auto"
                  onClick={handleClose}
                  disabled={isApplying}
                  className={cn(
                    "flex-1 h-[32px] rounded-[6px] border px-4",
                    "text-[13px] font-medium leading-[1.1]",
                    "border-grey-dark-100 bg-white text-[#111]",
                    "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
                    "hover:bg-[#F5F5F5]",
                    "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-300 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
                  )}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="auto"
                  onClick={handleSyncSelected}
                  disabled={selectedCount === 0 || isApplying}
                  loading={isApplying}
                  className={cn(
                    "flex-1 h-[32px] rounded-[6px] border px-4",
                    "text-[13px] font-medium leading-[1.1]",
                    "border-[#3167DD] bg-[#3167DD] text-white",
                    "hover:bg-[#2454c4] hover:border-[#2454c4]",
                    "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
                  )}
                >
                  {isApplying
                    ? "Applying…"
                    : isLocal
                      ? "Apply Selection"
                      : "Sync to Selected Device"}
                </Button>
              </div>
            </div>
          </BackgroundContainer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

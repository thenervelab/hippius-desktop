"use client";

/**
 * DEV-ONLY: Sync widget playground. Renders the SyncStatusDialog with
 * hand-crafted dummy snapshots so all visual states (preparing, syncing,
 * encrypting, decrypting, complete, failed, retrying, offline, etc.)
 * can be reviewed at-a-glance without triggering a real sync.
 *
 * Pick a preset from the dropdown to swap snapshots; pick "Live (real
 * backend)" to show the actual SyncStatusHandler instead. To remove
 * the playground entirely, swap `SyncWidgetPlayground` back to
 * `SyncStatusHandler` in `SyncFilesHandler.tsx` and delete this file.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Provider as JotaiProvider, createStore, useSetAtom } from "jotai";

import SyncStatusDialog from "./SyncStatusDialog";
import SyncStatusHandler from "./SyncStatusHandler";
import {
  type SyncSnapshot,
  type FileProgress,
} from "../lib/types/syncSnapshot";
import {
  syncEngineHealthAtom,
  DEFAULT_SYNC_ENGINE_HEALTH,
  type SyncEngineHealthState,
} from "../lib/store/syncAtoms";
import { sidebarCollapsedAtom } from "@/app/components/sidebar/sideBarAtoms";

const LIVE = "__live__";

function makeFile(overrides: Partial<FileProgress>): FileProgress {
  return {
    path: "/file",
    fileName: "file.dat",
    label: "default",
    action: "upload",
    status: "pending",
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    ...overrides,
  };
}

function snap(overrides: Partial<SyncSnapshot>): SyncSnapshot {
  return {
    isActive: false,
    overallPercent: 0,
    progressBytes: 0,
    bytesExpected: 0,
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    retryInSecs: 0,
    lastError: null,
    expectedUploads: 0,
    expectedDownloads: 0,
    expectedLocalDeletes: 0,
    expectedRemoteDeletes: 0,
    startedAt: null,
    completedAt: null,
    files: [],
    widgetState: "idle",
    widgetVisible: true,
    combinedProgressBytes: 0,
    combinedBytesExpected: 0,
    deletedCount: 0,
    syncedCount: 0,
    actualTotal: 0,
    statusVariant: "progress",
    syncDirection: "mixed",
    effectiveInProgress: false,
    effectiveCompleted: false,
    ...overrides,
  };
}

interface Preset {
  id: string;
  label: string;
  snapshot: SyncSnapshot;
  engineHealth?: SyncEngineHealthState;
}

const MB = 1024 * 1024;

const PRESETS: Preset[] = [
  {
    id: "preparing",
    label: "Preparing sync",
    snapshot: snap({
      isActive: true,
      widgetState: "preparing",
      effectiveInProgress: true,
      startedAt: Date.now(),
    }),
  },
  {
    id: "single-uploading",
    label: "Single file — uploading (45%)",
    snapshot: snap({
      isActive: true,
      widgetState: "active",
      effectiveInProgress: true,
      totalFiles: 1,
      actualTotal: 1,
      overallPercent: 45,
      progressBytes: 45 * MB,
      bytesExpected: 100 * MB,
      combinedProgressBytes: 45 * MB,
      combinedBytesExpected: 100 * MB,
      syncDirection: "upload",
      statusVariant: "progress",
      startedAt: Date.now() - 30_000,
      files: [
        makeFile({
          path: "/large-video.mp4",
          fileName: "large-video.mp4",
          action: "upload",
          status: "inProgress",
          progressPercent: 45,
          bytesTransferred: 45 * MB,
          totalBytes: 100 * MB,
        }),
      ],
    }),
  },
  {
    id: "single-encrypting",
    label: "Single file — encrypting",
    snapshot: snap({
      isActive: true,
      widgetState: "active",
      effectiveInProgress: true,
      totalFiles: 1,
      actualTotal: 1,
      overallPercent: 20,
      syncDirection: "upload",
      statusVariant: "progress",
      startedAt: Date.now() - 5_000,
      files: [
        makeFile({
          path: "/private/secret-doc.pdf",
          fileName: "secret-doc.pdf",
          action: "upload",
          status: "encrypting",
          progressPercent: 20,
          totalBytes: 5 * MB,
        }),
      ],
    }),
  },
  {
    id: "single-decrypting",
    label: "Single file — decrypting (download)",
    snapshot: snap({
      isActive: true,
      widgetState: "active",
      effectiveInProgress: true,
      totalFiles: 1,
      actualTotal: 1,
      overallPercent: 70,
      syncDirection: "download",
      statusVariant: "progress",
      startedAt: Date.now() - 10_000,
      files: [
        makeFile({
          path: "/photos/vacation.jpg",
          fileName: "vacation.jpg",
          action: "download",
          status: "decrypting",
          progressPercent: 70,
          totalBytes: 2_500_000,
        }),
      ],
    }),
  },
  {
    id: "multi-upload",
    label: "Multi-file — upload (60%)",
    snapshot: snap({
      isActive: true,
      widgetState: "active",
      effectiveInProgress: true,
      totalFiles: 5,
      actualTotal: 5,
      completedFiles: 2,
      syncedCount: 2,
      overallPercent: 60,
      progressBytes: 60 * MB,
      bytesExpected: 100 * MB,
      combinedProgressBytes: 60 * MB,
      combinedBytesExpected: 100 * MB,
      syncDirection: "upload",
      statusVariant: "progress",
      startedAt: Date.now() - 60_000,
      files: [
        makeFile({
          path: "/img/photo-1.png",
          fileName: "photo-1.png",
          action: "upload",
          status: "completed",
          progressPercent: 100,
          totalBytes: 1_500_000,
          bytesTransferred: 1_500_000,
        }),
        makeFile({
          path: "/img/photo-2.png",
          fileName: "photo-2.png",
          action: "upload",
          status: "completed",
          progressPercent: 100,
          totalBytes: 2_300_000,
          bytesTransferred: 2_300_000,
        }),
        makeFile({
          path: "/docs/quarterly-report.pdf",
          fileName: "quarterly-report.pdf",
          action: "upload",
          status: "inProgress",
          progressPercent: 50,
          totalBytes: 8 * MB,
          bytesTransferred: 4 * MB,
        }),
        makeFile({
          path: "/music/song.mp3",
          fileName: "song.mp3",
          action: "upload",
          status: "encrypting",
          progressPercent: 30,
          totalBytes: 4_200_000,
        }),
        makeFile({
          path: "/archive/backup-2026-05.zip",
          fileName: "backup-2026-05.zip",
          action: "upload",
          status: "pending",
          progressPercent: 0,
          totalBytes: 84 * MB,
        }),
      ],
    }),
  },
  {
    id: "multi-download",
    label: "Multi-file — download (mixed)",
    snapshot: snap({
      isActive: true,
      widgetState: "active",
      effectiveInProgress: true,
      totalFiles: 4,
      actualTotal: 4,
      completedFiles: 1,
      syncedCount: 1,
      overallPercent: 35,
      progressBytes: 35 * MB,
      bytesExpected: 100 * MB,
      combinedProgressBytes: 35 * MB,
      combinedBytesExpected: 100 * MB,
      syncDirection: "download",
      statusVariant: "progress",
      startedAt: Date.now() - 25_000,
      files: [
        makeFile({
          path: "/movies/movie.mkv",
          fileName: "movie.mkv",
          action: "download",
          status: "inProgress",
          progressPercent: 70,
          totalBytes: 50 * MB,
          bytesTransferred: 35 * MB,
        }),
        makeFile({
          path: "/docs/contract.docx",
          fileName: "contract.docx",
          action: "download",
          status: "decrypting",
          progressPercent: 90,
          totalBytes: 250_000,
        }),
        makeFile({
          path: "/notes/todo.txt",
          fileName: "todo.txt",
          action: "download",
          status: "completed",
          progressPercent: 100,
          totalBytes: 12_500,
          bytesTransferred: 12_500,
        }),
        makeFile({
          path: "/photos/wedding.jpg",
          fileName: "wedding.jpg",
          action: "download",
          status: "pending",
          progressPercent: 0,
          totalBytes: 4_500_000,
        }),
      ],
    }),
  },
  {
    id: "multi-delete",
    label: "Multi-file — deleting",
    snapshot: snap({
      isActive: true,
      widgetState: "active",
      effectiveInProgress: true,
      totalFiles: 3,
      actualTotal: 3,
      syncDirection: "delete",
      statusVariant: "progress",
      startedAt: Date.now() - 5_000,
      files: [
        makeFile({
          path: "/tmp/old-1.tmp",
          fileName: "old-1.tmp",
          action: "remote_delete",
          status: "inProgress",
          progressPercent: 50,
          totalBytes: 1024,
        }),
        makeFile({
          path: "/tmp/old-2.tmp",
          fileName: "old-2.tmp",
          action: "remote_delete",
          status: "pending",
          totalBytes: 2048,
        }),
        makeFile({
          path: "/tmp/old-3.tmp",
          fileName: "old-3.tmp",
          action: "remote_delete",
          status: "pending",
          totalBytes: 1536,
        }),
      ],
    }),
  },
  {
    id: "complete-single",
    label: "Complete — single file",
    snapshot: snap({
      isActive: false,
      widgetState: "completed",
      effectiveCompleted: true,
      totalFiles: 1,
      actualTotal: 1,
      completedFiles: 1,
      syncedCount: 1,
      overallPercent: 100,
      progressBytes: 2_500_000,
      bytesExpected: 2_500_000,
      syncDirection: "upload",
      statusVariant: "success",
      startedAt: Date.now() - 30_000,
      completedAt: Date.now(),
      files: [
        makeFile({
          path: "/photos/vacation.jpg",
          fileName: "vacation.jpg",
          action: "upload",
          status: "completed",
          progressPercent: 100,
          totalBytes: 2_500_000,
          bytesTransferred: 2_500_000,
        }),
      ],
    }),
  },
  {
    id: "complete-mixed",
    label: "Complete — uploads + deletes",
    snapshot: snap({
      isActive: false,
      widgetState: "completed",
      effectiveCompleted: true,
      totalFiles: 4,
      actualTotal: 4,
      completedFiles: 4,
      syncedCount: 2,
      deletedCount: 2,
      overallPercent: 100,
      syncDirection: "mixed",
      statusVariant: "success",
      startedAt: Date.now() - 120_000,
      completedAt: Date.now() - 5_000,
      files: [
        makeFile({
          path: "/img/a.png",
          fileName: "a.png",
          action: "upload",
          status: "completed",
          progressPercent: 100,
          totalBytes: 1_000_000,
          bytesTransferred: 1_000_000,
        }),
        makeFile({
          path: "/img/b.png",
          fileName: "b.png",
          action: "upload",
          status: "completed",
          progressPercent: 100,
          totalBytes: 2_000_000,
          bytesTransferred: 2_000_000,
        }),
        makeFile({
          path: "/tmp/old-1.tmp",
          fileName: "old-1.tmp",
          action: "remote_delete",
          status: "completed",
          progressPercent: 100,
          totalBytes: 1024,
        }),
        makeFile({
          path: "/tmp/old-2.tmp",
          fileName: "old-2.tmp",
          action: "remote_delete",
          status: "completed",
          progressPercent: 100,
          totalBytes: 2048,
        }),
      ],
    }),
  },
  {
    id: "failed",
    label: "Failed — partial sync",
    snapshot: snap({
      isActive: false,
      widgetState: "completed",
      effectiveCompleted: true,
      totalFiles: 3,
      actualTotal: 3,
      completedFiles: 1,
      failedFiles: 2,
      syncedCount: 1,
      overallPercent: 33,
      syncDirection: "upload",
      statusVariant: "error",
      lastError: "Network timeout while uploading 'huge.zip' (chunk 142/200)",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 2_000,
      files: [
        makeFile({
          path: "/docs/ok.txt",
          fileName: "ok.txt",
          action: "upload",
          status: "completed",
          progressPercent: 100,
          totalBytes: 1024,
          bytesTransferred: 1024,
        }),
        makeFile({
          path: "/archive/huge.zip",
          fileName: "huge.zip",
          action: "upload",
          status: "error",
          progressPercent: 71,
          totalBytes: 500 * MB,
          bytesTransferred: 350 * MB,
          error: "Network timeout",
        }),
        makeFile({
          path: "/docs/locked.docx",
          fileName: "locked.docx",
          action: "upload",
          status: "error",
          progressPercent: 0,
          totalBytes: 25_000,
          error: "Permission denied",
        }),
      ],
    }),
  },
  {
    id: "retrying",
    label: "Retrying — 30s countdown",
    snapshot: snap({
      isActive: false,
      widgetState: "retrying",
      retryInSecs: 30,
      totalFiles: 2,
      actualTotal: 2,
      failedFiles: 2,
      overallPercent: 0,
      syncDirection: "upload",
      statusVariant: "error",
      lastError: "Server returned 503 Service Unavailable",
      startedAt: Date.now() - 60_000,
      files: [
        makeFile({
          path: "/docs/a.txt",
          fileName: "a.txt",
          action: "upload",
          status: "error",
          error: "503",
          totalBytes: 5000,
        }),
        makeFile({
          path: "/docs/b.txt",
          fileName: "b.txt",
          action: "upload",
          status: "error",
          error: "503",
          totalBytes: 8000,
        }),
      ],
    }),
  },
  {
    id: "offline",
    label: "Disconnected — Offline",
    snapshot: snap({
      isActive: false,
      widgetState: "idle",
      totalFiles: 1,
      actualTotal: 1,
      files: [
        makeFile({
          path: "/queued/photo.png",
          fileName: "photo.png",
          action: "upload",
          status: "pending",
          totalBytes: 500_000,
        }),
      ],
    }),
    engineHealth: {
      ...DEFAULT_SYNC_ENGINE_HEALTH,
      status: "network_offline",
    },
  },
  {
    id: "server-unreachable",
    label: "Disconnected — Server unreachable",
    snapshot: snap({
      isActive: false,
      widgetState: "idle",
      totalFiles: 1,
      actualTotal: 1,
      files: [
        makeFile({
          path: "/queued/photo.png",
          fileName: "photo.png",
          action: "upload",
          status: "pending",
          totalBytes: 500_000,
        }),
      ],
    }),
    engineHealth: {
      ...DEFAULT_SYNC_ENGINE_HEALTH,
      status: "server_unreachable",
    },
  },
  {
    id: "auth-expired",
    label: "Disconnected — Session expired",
    snapshot: snap({
      isActive: false,
      widgetState: "idle",
      totalFiles: 1,
      actualTotal: 1,
      files: [
        makeFile({
          path: "/queued/photo.png",
          fileName: "photo.png",
          action: "upload",
          status: "pending",
          totalBytes: 500_000,
        }),
      ],
    }),
    engineHealth: {
      ...DEFAULT_SYNC_ENGINE_HEALTH,
      status: "auth_expired",
    },
  },
];

interface SyncWidgetPlaygroundProps {
  liveHost?: "portal" | "sidebar";
  /**
   * Sidebar collapse state (sidebar host only). When collapsed the playground
   * forces the compact ring and hides its dev controls — mirroring how the
   * live handler behaves in the narrow rail — so the collapsed-sidebar mini
   * can be previewed with dummy data.
   */
  collapsed?: boolean;
}

const SyncWidgetPlayground: React.FC<SyncWidgetPlaygroundProps> = ({
  liveHost = "portal",
  collapsed = false,
}) => {
  const [selected, setSelected] = useState<string>(PRESETS[0].id);
  const [dismissed, setDismissed] = useState(false);
  // Preview the compact circular form (sidebar-collapsed / minimized state).
  const [minified, setMinified] = useState(false);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);

  // The sidebar being collapsed forces the ring regardless of the checkbox,
  // matching the live handler's `collapsed || minimized` rule.
  const effectiveMinified = collapsed || minified;

  const preset = useMemo(
    () => PRESETS.find((p) => p.id === selected),
    [selected],
  );

  useEffect(() => {
    setDismissed(false);
  }, [selected]);

  // Fresh Jotai store per-preset so the engineHealth override is scoped
  // to this subtree and never leaks into the rest of the app.
  const store = useMemo(() => {
    if (!preset) return null;
    const s = createStore();
    s.set(
      syncEngineHealthAtom,
      preset.engineHealth ?? DEFAULT_SYNC_ENGINE_HEALTH,
    );
    return s;
  }, [preset]);

  const isLive = selected === LIVE;

  const expandOrigin = liveHost === "sidebar" ? "bottom-left" : "bottom-right";

  return (
    <div className="flex flex-col items-start gap-2">
      {/* Dev controls don't fit the collapsed rail — hide them and let the
          forced ring stand alone, just like the live handler. The -mx-3 lets
          the 235px panel bleed past the padded sidebar. */}
      {!collapsed && (
        <div className="-mx-3">
          <div className="bg-grey-100 border border-grey-80 w-[235px] shadow-menu rounded-md px-3 py-2 flex  flex-col gap-2">
            <div>
              <span className="text-[0.625rem] uppercase tracking-wide font-semibold text-warning-50">
                DEV
              </span>
              <span className="text-xs text-grey-30 font-medium">
                Sync widget preview
              </span>
            </div>
            <div className="w-full">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="text-xs w-full bg-grey-95 border border-grey-80 rounded px-2 py-1 text-grey-10 focus:outline-none focus:ring-1 focus:ring-primary-50"
              >
                <option value={LIVE}>Live (real backend)</option>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {!isLive && (
              <label className="flex items-center gap-1.5 text-xs text-grey-30 font-medium">
                <input
                  type="checkbox"
                  checked={minified}
                  onChange={(e) => setMinified(e.target.checked)}
                />
                Minified (collapsed) form
              </label>
            )}
          </div>
        </div>
      )}

      {/* The live handler owns its own -mx-3 (full card only); the dummy
          dialog does not, so we apply the bleed here for the full card and
          drop it for the ring so the ring stays aligned under the avatar. */}
      {isLive || !preset || !store ? (
        <SyncStatusHandler host={liveHost} collapsed={collapsed} />
      ) : dismissed ? null : (
        <div className={effectiveMinified ? "" : "-mx-3"}>
          <JotaiProvider store={store}>
            <SyncStatusDialog
              snapshot={preset.snapshot}
              open={true}
              minimized={effectiveMinified}
              expandOrigin={expandOrigin}
              onExpand={() => {
                setMinified(false);
                setSidebarCollapsed(false);
              }}
              onClose={() => setMinified(true)}
            />
          </JotaiProvider>
        </div>
      )}
    </div>
  );
};

export default SyncWidgetPlayground;

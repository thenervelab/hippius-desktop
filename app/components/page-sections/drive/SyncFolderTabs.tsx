import { FC, useEffect, useMemo, useState } from "react";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { Icons } from "@/components/ui";
import FolderCardContextMenu, {
  FolderCardMenuItem,
} from "@/app/components/ui/context-menu/FolderCardContextMenu";
import { FolderOpen, FolderSearch, PauseCircle, PlayCircle, Trash2, ServerCrash } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface SyncFolderTabsProps {
  labels: string[];
  /** Map of label → display name (derived from folder path). */
  displayNames?: Record<string, string>;
  selectedTab: string | null;
  onTabChange: (tab: string | null) => void;
  onBrowseContents?: (label: string) => void;
  onPauseSync?: (label: string) => void;
  onOpenInFinder?: (label: string) => void;
  onRemoveFromSync?: (label: string) => void;
  onDeleteFromServer?: (label: string) => void;
  pausedLabels?: string[];
}

const ALL_TAB = "All";


const SyncFolderTabs: FC<SyncFolderTabsProps> = ({
  labels,
  displayNames = {},
  selectedTab,
  onTabChange,
  onBrowseContents,
  onPauseSync,
  onOpenInFinder,
  onRemoveFromSync,
  onDeleteFromServer,
  pausedLabels = [],
}) => {
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);

  const tabs: TabOption[] = useMemo(
    () => [
      { tabName: ALL_TAB, icon: <Icons.Folder2 /> },
      ...labels.map((label) => ({
        tabName: label,
        displayName: displayNames[label] ?? label,
        icon: <Icons.FolderCloud />,
      })),
    ],
    [labels, displayNames]
  );

  const [fileManagerLabel, setFileManagerLabel] = useState("Finder");
  useEffect(() => {
    invoke<{ fileManagerLabel: string }>("get_platform_info")
      .then((info) => setFileManagerLabel(info.fileManagerLabel))
      .catch(() => {});
  }, []);

  if (labels.length < 2) return null;

  const activeTab = selectedTab ?? ALL_TAB;

  const handleTabChange = (tabName: string) => {
    onTabChange(tabName === ALL_TAB ? null : tabName);
  };

  const contextMenuItems: FolderCardMenuItem[] = tabContextMenu
    ? (() => {
        const isPaused = pausedLabels.includes(tabContextMenu.label);
        return [
          ...(onBrowseContents
            ? [
                {
                  icon: <FolderSearch className="size-4" />,
                  label: "Browse Contents",
                  onClick: () => onBrowseContents(tabContextMenu.label),
                },
              ]
            : []),
          ...(onPauseSync
            ? [
                {
                  icon: isPaused ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />,
                  label: isPaused ? "Resume Sync" : "Pause Sync",
                  onClick: () => onPauseSync(tabContextMenu.label),
                },
              ]
            : []),
          ...(onOpenInFinder
            ? [
                {
                  icon: <FolderOpen className="size-4" />,
                  label: `Open in ${fileManagerLabel}`,
                  onClick: () => onOpenInFinder(tabContextMenu.label),
                },
              ]
            : []),
          ...(onRemoveFromSync
            ? [
                {
                  icon: <Trash2 className="size-4" />,
                  label: "Remove from Sync",
                  onClick: () => onRemoveFromSync(tabContextMenu.label),
                },
              ]
            : []),
          ...(onDeleteFromServer
            ? [
                {
                  icon: <ServerCrash className="size-4" />,
                  label: "Delete from Server",
                  onClick: () => onDeleteFromServer(tabContextMenu.label),
                  variant: "destructive" as const,
                },
              ]
            : []),
        ];
      })()
    : [];

  return (
    <div className="mt-6 mb-5">
      <div
        className="border border-grey-80 rounded p-1 bg-grey-100 inline-flex flex-wrap select-none"
        onContextMenu={(e) => {
          // Find which tab was right-clicked by checking target
          const target = e.target as HTMLElement;
          const tabEl = target.closest("[data-tab-label]");
          if (tabEl) {
            const label = tabEl.getAttribute("data-tab-label");
            if (label && label !== ALL_TAB) {
              e.preventDefault();
              // Clear any text selection caused by right-click
              window.getSelection()?.removeAllRanges();
              setTabContextMenu({ x: e.clientX, y: e.clientY, label });
            }
          }
        }}
      >
        <TabList
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          gap="gap-1"
          width="w-auto @sm:min-w-[6.25rem] max-w-[15rem]"
          className="flex-wrap"
        />
      </div>

      {tabContextMenu && contextMenuItems.length > 0 && (
        <FolderCardContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          onClose={() => setTabContextMenu(null)}
          items={contextMenuItems}
        />
      )}
    </div>
  );
};

export default SyncFolderTabs;

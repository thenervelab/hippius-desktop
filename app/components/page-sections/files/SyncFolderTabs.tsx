import { FC, useMemo } from "react";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { Icons } from "@/components/ui";

interface SyncFolderTabsProps {
  labels: string[];
  selectedTab: string | null;
  onTabChange: (tab: string | null) => void;
}

const ALL_TAB = "All";

const SyncFolderTabs: FC<SyncFolderTabsProps> = ({
  labels,
  selectedTab,
  onTabChange,
}) => {
  const tabs: TabOption[] = useMemo(
    () => [
      { tabName: ALL_TAB, icon: <Icons.Folder2 /> },
      ...labels.map((label) => ({
        tabName: label,
        icon: <Icons.FolderCloud />,
      })),
    ],
    [labels]
  );

  if (labels.length < 2) return null;

  const activeTab = selectedTab ?? ALL_TAB;

  const handleTabChange = (tabName: string) => {
    onTabChange(tabName === ALL_TAB ? null : tabName);
  };

  return (
    <div className="mt-6 mb-5">
      <div className="border border-grey-80 rounded p-1 bg-grey-100 inline-flex flex-wrap">
        <TabList
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          gap="gap-1"
          width="w-auto sm:min-w-[100px] max-w-[240px]"
          className="flex-wrap"
        />
      </div>
    </div>
  );
};

export default SyncFolderTabs;

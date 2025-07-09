import { FC } from "react";
import { Icons } from "@/components/ui";
import StorageStateItem from "./StorageStateItem";

interface StorageStateListProps {
  storageUsed: string;
  numberOfFiles: number;
}

const StorageStateList: FC<StorageStateListProps> = ({
  storageUsed,
  numberOfFiles,
}) => {
  return (
    <div className="flex items-center flex-wrap gap-2">
      <StorageStateItem
        icon={<Icons.FolderCloud className="size-4" />}
        value={storageUsed}
        className="border-r border-grey-80 pr-2"
        label="Total Storage Used:"
      />
      <StorageStateItem
        icon={<Icons.FolderOpen className="size-4" />}
        value={numberOfFiles}
        className="pr-2"
        label="Number of Files:"
      />
    </div>
  );
};

export default StorageStateList;

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
    <div className="flex flex-col flex-wrap gap-2">
      <StorageStateItem
        icon={<Icons.FolderCloud className="size-4" />}
        value={storageUsed}
        className="pr-2"
        label="Used Storage:"
      />
      <StorageStateItem
        icon={<Icons.FolderOpen className="size-4" />}
        value={numberOfFiles}
        className="pr-2"
        label="Files:"
      />
    </div>
  );
};

export default StorageStateList;

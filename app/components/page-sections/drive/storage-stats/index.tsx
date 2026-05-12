import { FC } from "react";
import { Database, Folders } from "lucide-react";
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
    <div className="flex items-center gap-[5.5px] flex-wrap">
      <StorageStateItem
        icon={<Database className="size-[14px]" strokeWidth={1.5} />}
        value={storageUsed}
        label="Total Storage:"
      />
      <span
        aria-hidden
        className="size-[2.5px] rounded-full bg-primary-50 shrink-0"
      />
      <StorageStateItem
        icon={<Folders className="size-[14px]" strokeWidth={1.5} />}
        value={numberOfFiles}
        label="File No:"
      />
    </div>
  );
};

export default StorageStateList;

import { FC } from "react";
import { Database, Folders } from "lucide-react";
import StorageStateItem from "./StorageStateItem";

interface StorageStateListProps {
  storageUsed: string;
  numberOfFiles: number;
  /**
   * Console parity: "Drive size:" inside someone else's drive, "Total size:"
   * on a Shared with me list, "Storage Used:" on own drives. Never the old
   * catch-all "Total Storage:".
   */
  storageLabel?: string;
}

const StorageStateList: FC<StorageStateListProps> = ({
  storageUsed,
  numberOfFiles,
  storageLabel = "Storage Used:",
}) => {
  return (
    <div className="flex items-center gap-[5.5px] whitespace-nowrap">
      <StorageStateItem
        icon={<Database className="size-[14px]" strokeWidth={1.5} />}
        value={storageUsed}
        label={storageLabel}
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

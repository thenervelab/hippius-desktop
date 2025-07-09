import { FC } from "react";
import { getFilePartsFromFileName } from "@/lib/utils/get-file-parts-from-file-name";
import { Directory, Folder, DocumentFile } from "@/components/ui/icons";
import { decodeHexCid } from "@/lib/decode-hex-cid";
import Link from "next/link";

type NameCellProps = {
  rawName: string;
  fileDetails?: { filename: string; cid: string }[];
  cid: string;
};

const NameCell: FC<NameCellProps> = ({ rawName, fileDetails, cid }) => {
  const suffix = ".ec_metadata";
  const isDir = rawName.endsWith(suffix);

  // strip directory suffix
  let name = isDir ? rawName.slice(0, -suffix.length) : rawName;

  // truncate if base name > 30
  const { fileName: base, fileFormat: ext } =
    getFilePartsFromFileName(name);
  if (base.length > 30) {
    name = `${base.slice(0, 10)}...${base.slice(-6)}.${ext}`;
  }

  // pick icon
  const Icon = isDir
    ? Directory
    : (fileDetails?.length ?? 0) > 1
    ? Folder
    : DocumentFile;

  return (
    isDir ? (
        <Link
            href={`/dashboard/storage/ipfs/${decodeHexCid(cid)}`}
        >
            <div className="flex items-center">
                <Icon className="size-5 text-primary-90 mr-2.5" />
                <span className="text-grey-20">{name}</span>
            </div>
        </Link>
    ) : (
        <div className="flex items-center">
            <Icon className="size-5 text-primary-90 mr-2.5" />
            <span className="text-grey-20">{name}</span>
        </div>
    )
  );
};

export default NameCell;

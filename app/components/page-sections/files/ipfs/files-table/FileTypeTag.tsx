import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { File, Image, Video } from "lucide-react";
import { Directory } from "@/components/ui/icons";
import { FileTypes } from "@/lib/types/fileTypes";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";

const DEFAULT_FILE_FORMAT: FileTypes = "document";

const getLabelData = (type: FileTypes) => {
  switch (type) {
    case "video":
      return { label: "Video", Icon: Video };
    case "ec":
      return { label: "Erasure Coded", Icon: Directory };
    case "document":
      return { label: "Document", Icon: File };
    case "image":
      return { label: "Picture", Icon: Image };
  }
};

const fileTypeVariants = cva(
  "inline-flex items-center gap-1 rounded text-grey-10 px-2 py-1 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        document: "bg-[#FFFCE0]",
        video: "bg-[#E9F6F3]",
        ec: "bg-[#DAFBE8]",
        image: "bg-[#E1E7FE]",
      } as Record<FileTypes, string>,
    },
    defaultVariants: {
      variant: DEFAULT_FILE_FORMAT,
    },
  }
);

const FileTypeTag: React.FC<{ extension: string | null }> = ({ extension }) => {
  const fileType = getFileTypeFromExtension(extension);

  const labelData = getLabelData(fileType || DEFAULT_FILE_FORMAT) ?? { label: "Unknown", Icon: File };
  const { label, Icon } = labelData;

  return (
    <div
      className={cn(
        fileTypeVariants({ variant: fileType ? fileType : DEFAULT_FILE_FORMAT })
      )}
    >
      <Icon className="size-3" />
      <span>{label}</span>
    </div>
  );
};

export default FileTypeTag;

import * as React from "react";

import { cn, DEFAULT_FILE_FORMAT, FileTypes } from "@/lib/utils";
import { File, Image, Video } from "lucide-react";
import { Directory } from "@/components/ui/icons";

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

// Define variant classes for different file types
const fileTypeVariantClasses: Record<FileTypes, string> = {
  document: "bg-[#FFFCE0]",
  video: "bg-[#E9F6F3]",
  ec: "bg-[#DAFBE8]",
  image: "bg-[#E1E7FE]",
};

// Create a function to get the right classes based on variant
const getFileTypeVariantClasses = (variant: FileTypes | null) => {
  const baseClasses =
    "inline-flex items-center gap-1 rounded text-grey-10 px-2 py-1 text-xs font-semibold transition-colors";
  const variantClass = variant
    ? fileTypeVariantClasses[variant]
    : fileTypeVariantClasses[DEFAULT_FILE_FORMAT];
  return cn(baseClasses, variantClass);
};

const FileTypeTag: React.FC<{ fileType: FileTypes | null }> = ({
  fileType,
}) => {
  const { label, Icon } = getLabelData(fileType || DEFAULT_FILE_FORMAT);

  return (
    <div className={getFileTypeVariantClasses(fileType)}>
      <Icon className="size-3" />
      <span>{label}</span>
    </div>
  );
};

export default FileTypeTag;

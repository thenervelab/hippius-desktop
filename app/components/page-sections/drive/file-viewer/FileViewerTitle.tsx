"use client";

import React from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { cn } from "@/app/lib/utils";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";

interface FileViewerTitleProps {
  file: FormattedUserFile;
  className?: string;
}

const FileViewerTitle: React.FC<FileViewerTitleProps> = ({
  file,
  className,
}) => {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  const { icon: FileIcon, color: fileIconColor } = getFileIcon(
    fileType || undefined,
    false,
  );

  return (
    <div
      className={cn(
        "flex items-center gap-2 max-w-full min-w-0 shrink-0",
        className,
      )}
    >
      <FileIcon className={cn("size-[24px] shrink-0", fileIconColor)} />
      <span
        title={file.name}
        className={cn(
          "font-semibold text-[14px] leading-[22px] tracking-[-0.28px]",
          "text-grey-10 dark:text-grey-light-100",
          "truncate",
        )}
      >
        {file.name}
      </span>
    </div>
  );
};

export default FileViewerTitle;

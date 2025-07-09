"use client";

import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { P } from "@/components/ui/typography";
import { cn } from "@/lib/utils";
import {
  useState,
  useCallback,
  FC,
  DragEvent,
  ChangeEvent,
  useRef,
} from "react";

import { toast } from "sonner";
import { Icons } from "@/components/ui";

const FileDropzone: FC<{
  setFiles: (files: File[] | null) => void;
}> = ({ setFiles }) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList) => {
      if (!files.length) {
        toast.error("No Files Found");
        return;
      }

      const csvFiles = Array.from(files).filter((file) =>
        file.name.toLowerCase().endsWith(".csv")
      );

      if (csvFiles.length === 0) {
        toast.error("No CSV files found. Please upload files with .csv extension");
        return;
      }

      if (csvFiles.length < files.length) {
        toast.warning(
          `${files.length - csvFiles.length} non-CSV files were ignored`
        );
      }

      setFiles(csvFiles);
      toast.success(
        `${csvFiles.length} CSV ${csvFiles.length === 1 ? "file" : "files"} selected`
      );
    },
    [setFiles]
  );

  const handleOnChange = (e: ChangeEvent<HTMLInputElement>) => {
    const targetFiles = e.target.files;
    console.log("targetFiles", targetFiles);

    if (targetFiles) {
      handleFiles(targetFiles);
    }
  };

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const targetFiles = e.dataTransfer.files;
      if (targetFiles) {
        handleFiles(targetFiles);
      }
    },
    [handleFiles]
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };
  return (
    <div
      className="w-full h-full border border-grey-80 rounded-[8px] p-2"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <button
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "h-full w-full flex border border-dashed border-grey-80 justify-center py-5 px-10 bg-white cursor-pointer hover:bg-grey-90 duration-300 rounded-[8px]",
          isDragging && "bg-grey-90"
        )}
      >
        <div className="flex flex-col items-center">
          <AbstractIconWrapper transparent className="size-8">
            <Icons.BoxSimple2 className="relative" />
          </AbstractIconWrapper>

          <div className="mt-2 flex flex-col">
            <P className="font-semibold text-grey-10" size="sm">
              Upload your CSV File
            </P>
            <P
              size="xs"
              className="mt-2 text-center text-grey-60 max-w-[264px]"
            >
              Your CSV file should contain <br />
              &quot;name&quot; and &quot;cid&quot; pairs.
            </P>
          </div>
        </div>
      </button>
      <input
        multiple
        ref={fileInputRef}
        onChange={handleOnChange}
        className="hidden"
        type="file"
        accept=".csv,text/csv"
      />
    </div>
  );
};

export default FileDropzone;

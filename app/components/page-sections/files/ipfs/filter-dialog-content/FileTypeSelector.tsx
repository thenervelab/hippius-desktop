import React from "react";
import * as Menubar from "@radix-ui/react-menubar";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  Document,
  Video,
  Image,
  PDF,
  Presentation,
  Sheet,
  SVG,
  Terminal,
  EC,
  File,
} from "@/components/ui/icons";
import { FileTypes } from "@/lib/types/fileTypes";

const fileTypes: Array<{
  type: FileTypes;
  label: string;
  icon: React.FC<Record<string, unknown>>;
  color: string;
}> = [
    { type: "video", label: "Video", icon: Video, color: "text-[#ea4335]" },
    { type: "image", label: "Picture", icon: Image, color: "text-[#ea4335]" },
    {
      type: "document",
      label: "Unknown",
      icon: File,
      color: "text-primary-70 fill-primary-60",
    },
    { type: "PDF", label: "PDF", icon: PDF, color: "text-[#ea4335]" },
    {
      type: "PPT",
      label: "PPT",
      icon: Presentation,
      color: "text-[#fbbc04]",
    },
    { type: "XLS", label: "XLS", icon: Sheet, color: "text-[#34a853]" },
    { type: "code", label: "JSON File", icon: Terminal, color: "text-[#4285F4]" },
    { type: "svg", label: "SVG", icon: SVG, color: "text-black" },
    { type: "doc", label: "Doc", icon: Document, color: "text-[#4285F4]" },
    { type: "ec", label: "Folder", icon: EC, color: "text-primary-40" },
  ];

interface FileTypeSelectorProps {
  selectedTypes?: FileTypes[];
  onTypesSelect?: (types: FileTypes[]) => void;
}

const FileTypeSelector: React.FC<FileTypeSelectorProps> = ({
  selectedTypes = [],
  onTypesSelect,
}) => {
  const handleTypeToggle = (type: FileTypes) => {
    const newSelectedTypes = selectedTypes.includes(type)
      ? selectedTypes.filter((t) => t !== type)
      : [...selectedTypes, type];
    onTypesSelect?.(newSelectedTypes);
  };

  const getDisplayText = () => {
    if (selectedTypes.length === 0) return "Type";
    if (selectedTypes.length === 1) {
      const selectedType = fileTypes.find((ft) => ft.type === selectedTypes[0]);
      return selectedType?.label || "Type";
    }
    return `${selectedTypes.length} types selected`;
  };

  const getDisplayIcon = () => {
    if (selectedTypes.length === 1) {
      const selectedType = fileTypes.find((ft) => ft.type === selectedTypes[0]);
      if (selectedType) {
        return (
          <selectedType.icon
            className={cn("size-[14px]", selectedType.color)}
          />
        );
      }
    }
    return <Icons.FileFilter className="size-[14px] text-grey-10" />;
  };

  return (
    <Menubar.Root>
      <Menubar.Menu>
        <Menubar.Trigger asChild>
          <button className="flex justify-between p-2 bg-grey-90 w-full rounded border border-grey-80 hover:bg-grey-80 transition-colors">
            <div className="flex gap-2">
              <div className="flex justify-center items-center p-1">
                {getDisplayIcon()}
              </div>
              <div className="text-sm font-medium text-grey-10 leading-5">
                {getDisplayText()}
              </div>
            </div>
            <div className="rounded border border-prmary-80 bg-primary-100 flex justify-center items-center p-[3px]">
              <Icons.ChevronDown className="size-[14px] text-primary-50" />
            </div>
          </button>
        </Menubar.Trigger>
        <Menubar.Content className="mt-1 bg-white border border-grey-80 rounded-lg px-2 py-1 shadow-menu min-w-[326px] z-50">
          {fileTypes.map((fileType) => (
            <Menubar.Item
              key={fileType.type}
              className="flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
              onSelect={(e) => {
                e.preventDefault();
                handleTypeToggle(fileType.type);
              }}
            >
              <input
                type="checkbox"
                checked={selectedTypes.includes(fileType.type)}
                readOnly
                className="w-4 h-4 text-primary-60 bg-grey-90 border-grey-70 rounded focus:ring-primary-60 focus:ring-2 pointer-events-none"
              />
              <div className="flex gap-1.5 items-center">
                <div className="flex justify-center items-center p-0.5">
                  <fileType.icon
                    className={cn("size-4", fileType.color)}
                  />
                </div>
                <span className="flex-1 font-medium text-xs">{fileType.label}</span>
              </div>
            </Menubar.Item>
          ))}
        </Menubar.Content>
      </Menubar.Menu>
    </Menubar.Root>
  );
};

export default FileTypeSelector;

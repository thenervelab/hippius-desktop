import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import {
  Document,
  Video,
  Image,
  PDF,
  Presentation,
  Sheet,
  SVG,
  Terminal,
  Folder2,
  File,
  Zip,
  Note,
  CentralizedDataBase,
  DocumentText,
} from "@/components/ui/icons";
import { FileTypes } from "@/lib/types/fileTypes";

const fileTypes: Array<{
  type: FileTypes;
  label: string;
  icon: React.FC<Record<string, unknown>>;
  color: string;
}> = [
  { type: "folder", label: "Folder", icon: Folder2, color: "text-primary-40" },
  { type: "image", label: "Image", icon: Image, color: "text-[#ea4335]" },
  { type: "video", label: "Video", icon: Video, color: "text-[#ea4335]" },
  { type: "audio", label: "Audio", icon: Note, color: "text-[#9b59b6]" },
  { type: "PDF", label: "PDF", icon: PDF, color: "text-[#ea4335]" },
  { type: "doc", label: "Document", icon: Document, color: "text-[#4285F4]" },
  { type: "XLS", label: "Spreadsheet", icon: Sheet, color: "text-[#34a853]" },
  { type: "PPT", label: "Presentation", icon: Presentation, color: "text-[#fbbc04]" },
  { type: "archive", label: "Archive", icon: Zip, color: "text-[#f39c12]" },
  { type: "disk_image", label: "Disk Image", icon: File, color: "text-primary-70 fill-primary-60" },
  { type: "code", label: "Code", icon: Terminal, color: "text-[#4285F4]" },
  { type: "markdown", label: "Markdown", icon: DocumentText, color: "text-[#4285F4]" },
  { type: "sql", label: "Database", icon: CentralizedDataBase, color: "text-[#4285F4]" },
  { type: "svg", label: "SVG", icon: SVG, color: "text-black" },
  { type: "document", label: "Other", icon: File, color: "text-primary-70 fill-primary-60" },
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
    if (selectedTypes.length === 0) return "File Type";
    if (selectedTypes.length === 1) {
      const selectedType = fileTypes.find((ft) => ft.type === selectedTypes[0]);
      return selectedType?.label || "File Type";
    }
    return `${selectedTypes.length} types selected`;
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex justify-center group px-3 py-2 bg-grey-100 w-full rounded border border-grey-80 hover:bg-grey-80 min-w-[7rem] transition-colors">
          <div className="text-sm font-medium text-grey-40 leading-5">
            {getDisplayText()}
          </div>
          <Icons.ChevronDown className="ml-2 mt-0.5 size-4 text-grey-10 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={4}
          align="start"
          className="mt-1 bg-white border border-grey-80 rounded-lg px-2 py-1 shadow-menu min-w-[9.5625rem] z-50"
        >
          {fileTypes.map((fileType) => (
            <DropdownMenu.Item
              key={fileType.type}
              className="flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
              onSelect={(e) => {
                e.preventDefault();
                handleTypeToggle(fileType.type);
              }}
            >
              <Checkbox.Root
                className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors"
                checked={selectedTypes.includes(fileType.type)}
                onCheckedChange={() => handleTypeToggle(fileType.type)}
              >
                <Checkbox.Indicator>
                  <Check className="size-4 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <div className="flex gap-1 items-center">
                <div className="flex justify-center items-center p-0.5">
                  <fileType.icon className={cn("size-5", fileType.color)} />
                </div>
                <span className="flex-1 font-medium text-base text-grey-40">
                  {fileType.label}
                </span>
              </div>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

export default FileTypeSelector;

"use client";

import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import {
  Document,
  Video,
  Image,
  PDF,
  Presentation,
  Sheet,
  SVG,
  Terminal,
  File,
  CentralizedDataBase,
} from "@/components/ui/icons";
import {
  getFileExtensions,
  type FileExtension,
} from "@/app/lib/utils/fileTypeMapper";

/**
 * Console-equivalent extension dropdown for the desktop drive filters.
 *
 * UI shape mirrors `hippius-console`'s `FileExtensionSelector`: a single
 * "File Type" trigger, a dropdown grouped by category (Video, Image,
 * Document, Spreadsheet, Presentation, Code, Database), and a single-
 * select model with a "Clear Type Filter" item at the top when something
 * is already selected. This replaces the desktop's previous coarse
 * multi-select category list so a search/filter session matches whatever
 * the user is used to from the web app.
 */
const FILTER_PILL_TRIGGER_CLASSES = cn(
  "group inline-flex h-8 items-center gap-2 whitespace-nowrap",
  "rounded-[7px] border px-[8px] pr-[10px]",
  "bg-[#fefefe] border-[#e0e0e0]",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "text-[12px] font-medium font-mono uppercase tracking-[-0.24px] leading-[20px]",
  "text-black-700 transition-colors hover:bg-grey-light-700",
  "dark:bg-[rgba(255,255,255,0.02)] dark:border-black-300 dark:text-grey-light-100",
  "dark:shadow-[0px_0px_0px_1px_rgba(0,0,0,1)] dark:hover:bg-black-500",
);

const ICON_BY_NAME: Record<string, React.FC<Record<string, unknown>>> = {
  video: Video,
  image: Image,
  pdf: PDF,
  document: Document,
  file: File,
  sheet: Sheet,
  presentation: Presentation,
  code: Terminal,
  database: CentralizedDataBase,
  svg: SVG,
};

interface FileExtensionSelectorProps {
  /** Currently-selected extension (e.g. "mp4"), or undefined for "all". */
  selectedExtension?: FileExtension;
  /** Fires with the new selection (undefined to clear). */
  onExtensionSelect?: (extension: FileExtension | undefined) => void;
}

const FileExtensionSelector: React.FC<FileExtensionSelectorProps> = ({
  selectedExtension,
  onExtensionSelect,
}) => {
  const extensions = getFileExtensions();

  const handleToggle = (extension: FileExtension) => {
    if (selectedExtension === extension) {
      onExtensionSelect?.(undefined);
    } else {
      onExtensionSelect?.(extension);
    }
  };

  const triggerText = (() => {
    if (!selectedExtension) return "File Type";
    const ext = extensions.find((e) => e.value === selectedExtension);
    return ext?.label ?? "File Type";
  })();

  // Group preserves insertion order from `getFileExtensions` so categories
  // surface in the same order the console renders them.
  const grouped = extensions.reduce<Record<string, typeof extensions>>(
    (acc, ext) => {
      if (!acc[ext.category]) acc[ext.category] = [];
      acc[ext.category].push(ext);
      return acc;
    },
    {},
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={FILTER_PILL_TRIGGER_CLASSES} type="button">
          <div className="text-black-700 dark:text-grey-light-100">
            {triggerText}
          </div>
          <Icons.ChevronDown className="size-4 text-black-700 transition-transform duration-200 group-data-[state=open]:rotate-180 dark:text-grey-light-100" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={4}
          align="start"
          className="z-50 mt-1 max-h-[400px] min-w-[180px] overflow-y-auto rounded-lg border border-grey-80 bg-white px-2 py-1 shadow-menu dark:border-black-300 dark:bg-black-primary-bg"
        >
          {selectedExtension && (
            <>
              <DropdownMenu.Item
                className="flex w-full cursor-pointer items-center gap-2 rounded p-2 text-xs font-medium text-red-600 outline-none hover:bg-grey-80 dark:text-[#ff8b8b] dark:hover:bg-[#2a171b]"
                onSelect={(e) => {
                  e.preventDefault();
                  onExtensionSelect?.(undefined);
                }}
              >
                <X className="size-3.5" />
                <span>Clear Type Filter</span>
              </DropdownMenu.Item>
              <div className="my-1 border-t border-grey-90 dark:border-black-300" />
            </>
          )}
          {Object.entries(grouped).map(([category, exts]) => (
            <div key={category}>
              <div className="px-2 py-1 text-[11px] font-semibold uppercase text-grey-50 dark:text-grey-dark-700">
                {category}
              </div>
              {exts.map((ext) => {
                const IconComponent = ICON_BY_NAME[ext.icon];
                return (
                  <DropdownMenu.Item
                    key={ext.value}
                    className="flex w-full cursor-pointer items-center gap-2 rounded p-2 text-xs font-medium text-grey-40 outline-none hover:bg-grey-80 dark:text-grey-dark-800 dark:hover:bg-black-300/40 dark:hover:text-grey-light-100"
                    onSelect={(e) => {
                      e.preventDefault();
                      handleToggle(ext.value);
                    }}
                  >
                    <Checkbox.Root
                      className="flex h-4 w-4 items-center justify-center rounded border border-grey-70 bg-grey-90 transition-colors data-[state=checked]:border-primary-50 data-[state=checked]:bg-primary-50"
                      checked={selectedExtension === ext.value}
                      onCheckedChange={() => handleToggle(ext.value)}
                    >
                      <Checkbox.Indicator>
                        <Check className="size-4 text-white" />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    {IconComponent && (
                      <IconComponent className="size-4 text-grey-40 dark:text-grey-dark-800" />
                    )}
                    <span className="font-medium text-grey-40 dark:text-grey-dark-800 dark:group-hover:text-grey-light-100">
                      {ext.label}
                    </span>
                  </DropdownMenu.Item>
                );
              })}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

export default FileExtensionSelector;

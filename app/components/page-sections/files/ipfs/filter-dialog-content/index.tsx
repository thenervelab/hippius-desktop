import { CardButton, Icons } from "@/components/ui";
import React, { useState } from "react";
import FilterLabel from "./filter-label";
import FilterSearchInput from "./filter-search-input";
import FileTypeSelector from "./file-type-selector";
import DateSelector from "./date-selector";
import { FileTypes } from "@/lib/types/fileTypes";
import { FileSizeSelector } from "./file-size-selector";
import LocationTypeSelector from "./location-type-selector";

const FilterDialogContent: React.FC = () => {
  const [selectedFileTypes, setSelectedFileTypes] = useState<FileTypes[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedFileSize, setSelectedFileSize] = useState<number>(0);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  return (
    <div className="flex justify-between flex-col gap-2 h-full">
      <div className="flex flex-col gap-5 ">
        <div className="py-2 border-b border-grey-80">
          <FilterLabel>File Name</FilterLabel>
          <FilterSearchInput
            placeholder="Search file name"
            className="w-full"
          />
        </div>

        <div className="pb-2 border-b border-grey-80 w-full">
          <FilterLabel>File Type</FilterLabel>
          <FileTypeSelector
            selectedTypes={selectedFileTypes}
            onTypesSelect={setSelectedFileTypes}
          />
        </div>

        <div className="pb-2 border-b border-grey-80 w-full">
          <FilterLabel>Date Uploaded</FilterLabel>
          <DateSelector
            selectedDate={selectedDate}
            onDateSelect={setSelectedDate}
          />
        </div>

        <div className="pb-2 border-b border-grey-80 w-full">
          <FileSizeSelector
            value={selectedFileSize}
            onValueChange={(value) => setSelectedFileSize(value)}
          />
        </div>

        <div className="pb-2  w-full">
          <FilterLabel>File Location</FilterLabel>
          <LocationTypeSelector
            selectedPaths={selectedPaths}
            onPathsSelect={setSelectedPaths}
          />
        </div>
      </div>
      <div className="flex gap-2 h-10 mt-auto ">
        <CardButton className="w-full " variant="secondary">
          <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
            Reset
          </div>
        </CardButton>
        <CardButton className="w-full ">
          <div className="flex items-center gap-2 ">
            <Icons.Filter className="size-4" />
            <span className="flex items-center text-lg font-medium">
              Filter
            </span>
          </div>
        </CardButton>
      </div>
    </div>
  );
};

export default FilterDialogContent;

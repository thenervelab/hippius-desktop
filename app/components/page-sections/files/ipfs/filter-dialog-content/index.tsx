import { CardButton, Icons } from "@/components/ui";
import React, { useEffect, useState } from "react";
import FilterLabel from "./FilterLabel";
import FileTypeSelector from "./FileTypeSelector";
import DateSelector from "./DateSelector";
import { FileTypes } from "@/lib/types/fileTypes";
import { FileSizeSelector } from "./FileSizeSelector";

interface FilterDialogContentProps {
  selectedFileTypes: FileTypes[];
  selectedDate: string;
  selectedFileSize: number;
  selectedSizeUnit: string;

  onApplyFilters: (
    fileTypes: FileTypes[],
    date: string,
    fileSize: number,
    sizeUnit: string
  ) => void;
  onResetFilters: () => void;
}

const FilterDialogContent: React.FC<FilterDialogContentProps> = ({
  selectedFileTypes,
  selectedDate,
  selectedFileSize,
  selectedSizeUnit,
  onApplyFilters,
  onResetFilters,
}) => {
  const [tempFileTypes, setTempFileTypes] = useState<FileTypes[]>(selectedFileTypes);
  const [tempDate, setTempDate] = useState<string>(selectedDate);
  const [tempFileSize, setTempFileSize] = useState<number>(selectedFileSize);
  const [tempSizeUnit, setTempSizeUnit] = useState<string>(selectedSizeUnit);

  useEffect(() => {
    setTempFileTypes(selectedFileTypes);
    setTempDate(selectedDate);
    setTempFileSize(selectedFileSize);
    setTempSizeUnit(selectedSizeUnit);
  }, [selectedFileTypes, selectedDate, selectedFileSize, selectedSizeUnit]);

  const handleApplyFilters = () => {
    onApplyFilters(tempFileTypes, tempDate, tempFileSize, tempSizeUnit);
  };

  const handleResetFilters = () => {
    setTempFileTypes([]);
    setTempDate("");
    setTempFileSize(0);
    setTempSizeUnit("GB");
    onResetFilters();
  };

  return (
    <div className="flex justify-between flex-col gap-2 h-full">
      <div className="flex flex-col gap-5 ">
        <div className="pb-2 border-b border-grey-80 w-full">
          <FilterLabel>File Type</FilterLabel>
          <FileTypeSelector
            selectedTypes={tempFileTypes}
            onTypesSelect={setTempFileTypes}
          />
        </div>

        <div className="pb-2 border-b border-grey-80 w-full">
          <FilterLabel>Date Uploaded</FilterLabel>
          <DateSelector selectedDate={tempDate} onDateSelect={setTempDate} />
        </div>

        <div className="mb-2 pb-2 w-full">
          <FileSizeSelector
            value={tempFileSize}
            onValueChange={setTempFileSize}
            onUnitChange={setTempSizeUnit}
            initialUnit={tempSizeUnit}
          />
        </div>
      </div>
      <div className="flex gap-2 h-10 mt-auto ">
        <CardButton
          className="w-full "
          variant="secondary"
          onClick={handleResetFilters}
        >
          <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
            Reset
          </div>
        </CardButton>
        <CardButton className="w-full" onClick={handleApplyFilters}>
          <div className="flex items-center gap-2 ">
            <Icons.Filter className="size-4" />
            <span className="flex items-center text-lg font-medium">Filter</span>
          </div>
        </CardButton>
      </div>
    </div>
  );
};

export default FilterDialogContent;

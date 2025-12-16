import React from "react";
import { cn } from "@/lib/utils";
import { Icons } from "../../ui";

export interface ImageCellProps {
  value: {
    os: "Linux" | "Ubuntu";
    version: string;
  };
  iconClass?: string;
}

const ImageCell: React.FC<ImageCellProps> = ({
  value,
  iconClass = "size-5",
}) => {
  return (
    <div className="flex items-center gap-2">
      {value.os === "Linux" ? (
        <Icons.Linux className={cn(iconClass)} />
      ) : (
        <Icons.Ubuntu className={cn(iconClass)} />
      )}
      <div className="flex gap-2  items-center">
        <span className="text-grey-20 font-medium text-base">{value.os}</span>
        <span className="text-grey-70 text-xs">|</span>
        <span className="text-grey-70 text-xs"> {value.version}</span>
      </div>
    </div>
  );
};

export default ImageCell;

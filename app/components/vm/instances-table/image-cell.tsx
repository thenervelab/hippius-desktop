import React from "react";
import { cn } from "@/lib/utils";
import { Icons } from "../../ui";

export interface ImageCellProps {
  value: {
    os: "AlmaLinux" | "Debian" | "Rocky Linux" | "Ubuntu";
    version: string;
  };
  iconClass?: string;
}

const ImageCell: React.FC<ImageCellProps> = ({
  value,
  iconClass = "size-5",
}) => {
  const getIcon = () => {
    switch (value.os) {
      case "Ubuntu":
        return <Icons.Ubuntu className={cn(iconClass)} />;
      case "AlmaLinux":
        return <Icons.Linux className={cn(iconClass)} />;
      case "Debian":
        return <Icons.Linux className={cn(iconClass)} />;
      case "Rocky Linux":
        return <Icons.Linux className={cn(iconClass)} />;
      default:
        return <Icons.Linux className={cn(iconClass)} />;
    }
  };

  return (
    <div className="flex items-center gap-2">
      {getIcon()}
      <div className="flex gap-2  items-center">
        <span className="text-grey-20 font-medium text-base">{value.os}</span>
        <span className="text-grey-70 text-xs">|</span>
        <span className="text-grey-70 text-xs"> {value.version}</span>
      </div>
    </div>
  );
};

export default ImageCell;

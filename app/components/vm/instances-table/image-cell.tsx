import React from "react";
import { Icons } from "../../ui";

export interface ImageCellProps {
  value: {
    os: "AlmaLinux" | "CentOS" | "Debian" | "Fedora" | "Rocky Linux" | "Ubuntu";
    version: string;
  };
  iconClass?: string;
}

const ImageCell: React.FC<ImageCellProps> = ({ value }) => {
  const getIcon = () => {
    switch (value.os) {
      case "Ubuntu":
        return <Icons.Ubuntu className="size-3" />;
      case "AlmaLinux":
        return <Icons.Linux className="size-3" />;
      case "CentOS":
        return <Icons.CentOS className="size-3" />;
      case "Debian":
        return <Icons.Debian className="size-3" />;
      case "Fedora":
        return <Icons.Fedora className="size-3" />;
      case "Rocky Linux":
        return <Icons.Linux className="size-3" />;
      default:
        return <Icons.Linux className="size-3" />;
    }
  };

  return (
    <div className="flex items-center gap-[8px] min-w-0">
      <div className="flex size-[20px] shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-black/[0.03] dark:bg-white/[0.03]">
        {getIcon()}
      </div>
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white whitespace-nowrap shrink-0">
        {value.os}
      </span>
      <span className="inline-block h-[14px] w-px shrink-0 bg-[#e3e3e3] dark:bg-[#313131]" />
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#a3a3a3] whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
        {value.version}
      </span>
    </div>
  );
};

export default ImageCell;

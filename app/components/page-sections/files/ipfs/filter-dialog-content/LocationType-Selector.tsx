import React from "react";
import * as Menubar from "@radix-ui/react-menubar";
import { Icons } from "@/components/ui";

// Static folder paths for now - will be dynamic later
const folderPaths = [
  "/home/user/Documents",
  "/home/user/Downloads",
  "/home/user/Pictures",
  "/home/user/Videos",
  "/home/user/Music",
  "/home/user/Desktop",
  "/var/www/html",
  "/opt/applications",
  "/usr/local/bin",
  "/tmp/uploads",
];

interface LocationTypeSelectorProps {
  selectedPaths?: string[];
  onPathsSelect?: (paths: string[]) => void;
}

const LocationTypeSelector: React.FC<LocationTypeSelectorProps> = ({
  selectedPaths = [],
  onPathsSelect,
}) => {
  const handlePathToggle = (path: string) => {
    const newSelectedPaths = selectedPaths.includes(path)
      ? selectedPaths.filter((p) => p !== path)
      : [...selectedPaths, path];
    onPathsSelect?.(newSelectedPaths);
  };

  const getDisplayText = () => {
    if (selectedPaths.length === 0) return "Location";
    if (selectedPaths.length === 1) {
      return selectedPaths[0];
    }
    return `${selectedPaths.length} locations selected`;
  };

  return (
    <Menubar.Root>
      <Menubar.Menu>
        <Menubar.Trigger asChild>
          <button className="flex justify-between p-2 bg-grey-90 w-full rounded border border-grey-80 hover:bg-grey-80 transition-colors">
            <div className="flex gap-2">
              <div className="flex justify-center items-center">
                <Icons.FolderMinus className="size-[18px] text-grey-10" />
              </div>
              <div className="text-sm font-medium text-grey-10 leading-5 truncate">
                {getDisplayText()}
              </div>
            </div>
            <div className="rounded border border-prmary-80 bg-primary-100 flex justify-center items-center p-[3px]">
              <Icons.ChevronDown className="size-[14px] text-primary-50" />
            </div>
          </button>
        </Menubar.Trigger>
        <Menubar.Content className="mt-1 bg-white border border-grey-80 rounded-lg px-2 py-1 shadow-menu min-w-[326px] z-50">
          {folderPaths.map((path) => (
            <Menubar.Item
              key={path}
              className="flex items-center gap-2 p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
              onSelect={(e) => e.preventDefault()}
            >
              <input
                type="checkbox"
                checked={selectedPaths.includes(path)}
                onChange={(e) => {
                  e.stopPropagation();
                  handlePathToggle(path);
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 text-primary-60 bg-grey-90 border-grey-70 rounded focus:ring-primary-60 focus:ring-2"
              />
              <span className="flex-1 truncate" title={path}>
                {path}
              </span>
            </Menubar.Item>
          ))}
        </Menubar.Content>
      </Menubar.Menu>
    </Menubar.Root>
  );
};

export default LocationTypeSelector;

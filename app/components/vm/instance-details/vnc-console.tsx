import React from "react";
import StatusCell from "../instances-table/status-cell";
import { Instance } from "../instances-table";
import Skeleton from "@/components/ui/skeleton";
import { ComingSoon } from "@/components/ui";

interface VncConsoleProps {
  instance?: Instance;
  isLoading?: boolean;
}

const VncConsole: React.FC<VncConsoleProps> = ({
  instance,
  isLoading = false,
}) => {
  return (
    <div className=" relative w-full border border-grey-80 rounded-lg overflow-hidden r">
      <ComingSoon
        variant="white"
        overlay={true}
        blurIntensity="extraLight"
        position="top-right"
        size="small"
      />
      {/* Status Bar */}
      <div className=" w-full bg-grey-100 border-b border-grey-80 py-3.5 flex items-center justify-center">
        {isLoading ? (
          <Skeleton className="!h-[24px] !w-[300px]" />
        ) : (
          <div className="flex items-center gap-1">
            <StatusCell value="Connected" className="p-0" />
            <span className="text-sm text-grey-10">
              to Virtual Machine {instance?.name}
            </span>
          </div>
        )}
      </div>
      <div className="w-full sm:h-[664px] p-3 sm:p-10 bg-grey-100 bg-[url('/vnc-bg-grid.png')] bg-repeat-round bg-cove">
        {/* VNC Console Content */}
        <div className="relative w-full h-full    ">
          <img
            src="/placeholder-terminal.png"
            alt="Placeholder Terminal"
            className="aspect-[1018/530] w-full h-full object-contain"
          />
        </div>
      </div>
    </div>
  );
};

export default VncConsole;

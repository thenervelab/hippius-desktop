import React from "react";
import { Instance } from "../instances-table";
import Skeleton from "@/components/ui/skeleton";
import { ComingSoon } from "@/components/ui";
import { NoEntriesBackgroundContainer } from "@/components/ui/NoEntriesBackgroundContainer";

interface VncConsoleProps {
  instance?: Instance;
  isLoading?: boolean;
}

const VncConsole: React.FC<VncConsoleProps> = ({
  instance,
  isLoading = false,
}) => {
  return (
    <div className="relative w-full border border-grey-80 dark:border-black-300 rounded-lg overflow-hidden">
      <ComingSoon
        variant="white"
        overlay={true}
        blurIntensity="extraLight"
        position="top-right"
        size="small"
      />
      {/* Status Bar */}
      <div className="w-full bg-white dark:bg-black-primary-bg border-b border-grey-80 dark:border-black-300 py-2 px-[1.875rem] flex items-center">
        {isLoading ? (
          <Skeleton className="!h-[1.5rem] !w-[18.75rem]" />
        ) : (
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="border-[0.1875rem] p-[0.1875rem] rounded-full border-success-80 bg-success-40 shrink-0"
            />
            <span className="font-medium text-base leading-[22px] tracking-[-0.32px] text-black-700 dark:text-grey-light-100">
              Connected to Virtual Machine {instance?.name}
            </span>
          </div>
        )}
      </div>
      <div className="relative w-full bg-grey-light-600 dark:bg-black-primary-bg p-8 sm:p-14 2xl:p-20 flex items-center justify-center overflow-hidden">
        {/* VNC Console Content — reuses the NoEntriesFound card shell
            (decoration lines, corner hippos, layered borders) so the empty
            terminal placeholder reads as a single intentional surface.
            overflow-hidden on the parent keeps the decoration textures
            from bleeding into the status bar above. */}
        <NoEntriesBackgroundContainer className="max-w-[900px]">
          <img
            src="/placeholder-terminal.png"
            alt="Placeholder Terminal"
            className="aspect-[1018/530] w-full object-contain block"
          />
        </NoEntriesBackgroundContainer>
      </div>
    </div>
  );
};

export default VncConsole;

import { CircleSlash } from "lucide-react";

import { cn } from "@/lib/utils";
import AbstractIconWrapper from "../abstract-icon-wrapper";
import { P } from "../typography";

const NoEntriesFound: React.FC<{
  children?: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    className={cn(
      "w-full h-[300px] p-6 flex items-center justify-center",
      className
    )}
  >
    <div className="flex flex-col items-center justify-center">
      <AbstractIconWrapper className="size-6 flex items-center justify-center">
        <CircleSlash className="size-5 text-primary-50 relative" />
      </AbstractIconWrapper>
      {children || (
        <P className="text-center mt-2 text-grey-60 max-w-[190px]" size="xs">
          No Entries found
        </P>
      )}
    </div>
  </div>
);

export default NoEntriesFound;

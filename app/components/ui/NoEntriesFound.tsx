import { CircleSlash } from "lucide-react";
import AbstractIconWrapper from "./abstract-icon-wrapper";
import { P } from "./typography";
import { cn } from "@/lib/utils";

interface NoEntriesFoundProps {
  children?: React.ReactNode;
  className?: string;
  text?: string;
}

const NoEntriesFound: React.FC<NoEntriesFoundProps> = ({
  children,
  className,
  text = "No Entries found",
}) => (
  <div
    className={cn(
      "w-full h-[25rem] p-6 flex items-center justify-center",
      className
    )}
  >
    <div className="flex flex-col items-center justify-center gap-3">
      <AbstractIconWrapper className="size-12 flex items-center justify-center">
        <CircleSlash className="size-7 text-primary-50 relative" />
      </AbstractIconWrapper>
      {children || (
        <div className="text-center">
          <P className="text-grey-30 font-semibold mb-1" size="md">
            {text}
          </P>
        </div>
      )}
    </div>
  </div>
);

export default NoEntriesFound;

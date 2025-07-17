import { AbstractIconWrapper, P, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

interface WaitAMomentProps {
  isRecentFiles?: boolean;
}

const WaitAMoment: React.FC<WaitAMomentProps> = ({ isRecentFiles = false }) => (
  <div
    className={cn("w-full p-6 flex items-center justify-center", {
      "h-[80vh]": !isRecentFiles,
      "h-[20vh]": isRecentFiles,
    })}
  >
    <div className="flex flex-col items-center justify-center">
      <AbstractIconWrapper className="size-6 flex items-center justify-center">
        <Icons.Timer className="size-4 text-primary-50 relative" />
      </AbstractIconWrapper>
      <P className="text-center mt-2 text-grey-60 max-w-[190px]" size="sm">
        Wait a moment...
      </P>
    </div>
  </div>
);

export default WaitAMoment;

import { HippiusLogo } from "@/components/ui/icons";
import { cn } from "@/app/lib/utils";

type HippiusBrandMarkProps = {
  logoClassName?: string;
  textClassName?: string;
};

export function HippiusBrandMark({
  logoClassName,
  textClassName,
}: HippiusBrandMarkProps) {
  return (
    <>
      <HippiusLogo
        className={cn("size-[28px] text-primary-50", logoClassName)}
      />
      <span
        className={cn(
          "font-[557] text-[18px] leading-[18px] tracking-[0px] text-primary-50",
          textClassName,
        )}
      >
        Hippius
      </span>
    </>
  );
}

export default HippiusBrandMark;

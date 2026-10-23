import { HippiusFlatLogo } from "@/components/ui/icons";
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
      {/* Brand kit: flat mark, lighter blue on dark; never on a blue surface. */}
      <HippiusFlatLogo
        className={cn(
          "size-[28px] text-primary-50 dark:text-primary-60",
          logoClassName,
        )}
      />
      <span
        className={cn(
          "font-[557] text-[18px] leading-[18px] tracking-[0px] text-black-700 dark:text-white",
          textClassName,
        )}
      >
        Hippius
      </span>
    </>
  );
}

export default HippiusBrandMark;

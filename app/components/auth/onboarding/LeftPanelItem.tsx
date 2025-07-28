import { cn } from "@/app/lib/utils";
import { RevealTextLine } from "@/components/ui";
import Image from "next/image";

interface LeftPanelItemProps {
  titleText: string;
  description: string;
  imagePath: string;
  imageMarginBottom?: string;
  inView: boolean;
  imagClassName?: string;
}

const LeftPanelItem = ({
  titleText,
  description,
  imagePath,
  imageMarginBottom = "mb-[75px]",
  inView,
  imagClassName
}: LeftPanelItemProps) => {
  return (
    <div className="absolute inset-0 right-0 left-0 z-4 h-full flex gap-4 justify-between flex-col">
      {/* text */}
      <div className="flex flex-col gap-[9px] mx-8 mt-8">
        <div className="text-primary-50 text-[40px] leading-[48px] font-medium">
          <RevealTextLine rotate reveal={inView} className="delay-300">
            {titleText}
          </RevealTextLine>
        </div>
        <div className="text-grey-50 text-base font-medium">
          <RevealTextLine rotate reveal={inView} className="delay-300">
            {description}
          </RevealTextLine>
        </div>
      </div>

      {/* images */}
      <div
        className={`${imageMarginBottom} w-full self-center h-full relative overflow-hidden`}
      >
        {/* Use inView to control animation state directly */}
        <div
          style={{ transitionDelay: "300ms" }}
          className={`
            absolute inset-0
            transform
            ${
              inView
                ? "translate-y-0 opacity-100"
                : "translate-y-full opacity-0"
            }
            transition-all
            duration-500
          `}
        >
          <Image
            src={imagePath}
            alt={titleText}
            fill
            unoptimized
            className={cn("object-contain object-bottom", imagClassName)}
          />
        </div>
      </div>
    </div>
  );
};

export default LeftPanelItem;

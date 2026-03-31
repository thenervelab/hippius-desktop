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
  imageMarginBottom = "mb-[4.6875rem]",
  inView,
  imagClassName
}: LeftPanelItemProps) => {
  return (
    <div className="absolute inset-0 right-0 left-0 z-4 h-full flex gap-4 justify-between flex-col">
      {/* text */}
      <div className="flex flex-col gap-[min(0.5625rem,9px)] mx-[min(2rem,32px)] mt-[min(2rem,32px)]">
        <div className="text-primary-50 text-[min(2.5rem,40px)] leading-[min(3rem,48px)] font-medium">
          <RevealTextLine rotate reveal={inView} className="delay-300">
            {titleText}
          </RevealTextLine>
        </div>
        <div className="text-grey-50 text-[min(1rem,16px)] font-medium">
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

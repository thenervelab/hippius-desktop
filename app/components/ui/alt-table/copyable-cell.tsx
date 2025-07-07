import React from "react";
import { CopyText } from "@/components/ui";
import { cn, shortenCopyAbleText } from "@/app/lib/utils";
import { useBreakpoint } from "@/app/lib/hooks";
import Link from "next/link";

export const CopyableCell: React.FC<{
  copyAbleText: string;
  link?: string;
  title: string;
  toastMessage: string;
  forSmallScreen?: boolean;
  copyIconClassName?: string;
  checkIconClassName?: string;
  buttonClass?: string;
  textColor?: string;
  className?: string;
  isTable?: boolean;
  linkClass?: string;
}> = ({
  copyAbleText,
  link,
  title,
  toastMessage,
  forSmallScreen,
  copyIconClassName,
  buttonClass,
  textColor,
  checkIconClassName,
  className,
  isTable,
  linkClass,
}) => {
  const { isMobile, isLaptop, isDesktop, isLargeDesktop } = useBreakpoint();
  const display = forSmallScreen
    ? shortenCopyAbleText(copyAbleText)
    : shortenCopyAbleText(copyAbleText, {
        isMobile,
        isLaptop,
        isDesktop,
        isLargeDesktop,
        isTable,
      });
  return (
    <CopyText
      text={copyAbleText}
      title={title}
      toastMessage={toastMessage}
      copyIconClassName={copyIconClassName}
      buttonClass={buttonClass}
      checkIconClassName={checkIconClassName}
      className={className}
    >
      {link ? (
        <Link
          href={link}
          className={cn("text-grey-20 hover:text-primary-50", linkClass)}
        >
          {display}
        </Link>
      ) : (
        <span
          onClick={(e) => e.stopPropagation()}
          className={cn(textColor ? textColor : "text-grey-20")}
        >
          {display}
        </span>
      )}
    </CopyText>
  );
};

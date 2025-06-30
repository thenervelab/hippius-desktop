import React from "react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import CopyText from "../copy-text";
import { shortenCopyAbleText } from "@/lib/utils/shortenCopyAbleText";
import { useBreakpoint } from "@/app/lib/hooks";

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
  showCopyAbleText?: boolean;
  truncationStyle?: "end" | "middle";
  className?: string;
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
  showCopyAbleText = true,
  truncationStyle = "end",
  className,
}) => {
  const { isMobile, isTablet, isLaptop, isDesktop, isLargeDesktop } =
    useBreakpoint();

  let display;

  // For CIDs or similar long strings, use the truncation style provided
  if (truncationStyle === "middle") {
    display = shortenCopyAbleText(copyAbleText, {
      style: "middle",
      startLen: isMobile ? 8 : isTablet ? 10 : isLaptop ? 12 : 20,
      endLen: isMobile ? 5 : isTablet ? 7 : isLaptop ? 10 : 15,
    });
  } else if (forSmallScreen) {
    display = shortenCopyAbleText(copyAbleText);
  } else {
    display = shortenCopyAbleText(copyAbleText, {
      isMobile,
      isLaptop,
      isDesktop,
      isLargeDesktop,
    });
  }

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
          target="_blank"
          rel="noopener noreferrer"
          className="text-grey-20 hover:text-primary-50"
        >
          {display}
        </Link>
      ) : (
        showCopyAbleText && (
          <span className={cn(textColor ? textColor : "text-grey-20")}>
            {display}
          </span>
        )
      )}
    </CopyText>
  );
};

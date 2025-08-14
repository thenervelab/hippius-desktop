import React, { ReactNode, useRef, useState, useEffect } from "react";
import * as Icons from "./icons";

interface InfoTooltipProps {
  children: ReactNode;
  className?: string;
  iconSize?: number | string;
  iconColor?: string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({
  children,
  className = "",
  iconSize = 4,
  iconColor = "text-grey-50"
}) => {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [arrowStyle, setArrowStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const calculatePosition = () => {
      if (!tooltipRef.current || !iconRef.current || !containerRef.current)
        return;

      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const iconRect = iconRef.current.getBoundingClientRect();
      const containerRect = containerRef.current.getBoundingClientRect();

      // Reset styles for accurate measurement
      setTooltipStyle({});

      // Get viewport dimensions
      const viewportWidth = window.innerWidth;

      // Calculate horizontal position
      const newTooltipStyle: React.CSSProperties = {
        maxWidth: "260px",
        width: "max-content"
      };

      const newArrowStyle: React.CSSProperties = {
        position: "absolute",
        width: 0,
        height: 0
      };

      // Vertical positioning - check if there's enough space on top
      const spaceAbove = iconRect.top;
      const shouldBeOnTop = spaceAbove >= tooltipRect.height;

      if (shouldBeOnTop) {
        // Position above the icon
        newTooltipStyle.bottom = "100%";
        newTooltipStyle.marginBottom = "8px";
        newArrowStyle.bottom = "-8px";
        newArrowStyle.borderLeft = "8px solid transparent";
        newArrowStyle.borderRight = "8px solid transparent";
        newArrowStyle.borderTop = "8px solid white";
      } else {
        // Position below the icon
        newTooltipStyle.top = "100%";
        newTooltipStyle.marginTop = "8px";
        newArrowStyle.top = "-8px";
        newArrowStyle.borderLeft = "8px solid transparent";
        newArrowStyle.borderRight = "8px solid transparent";
        newArrowStyle.borderBottom = "8px solid white";
      }

      // Get the absolute position of the icon center on screen
      const iconCenterX = iconRect.width / 2;
      const tooltipHalfWidth = tooltipRect.width / 2;

      // Calculate absolute positions considering the viewport
      const iconCenterPosition = iconRect.left + iconCenterX;
      const spaceToLeft = iconCenterPosition;
      const spaceToRight = viewportWidth - iconCenterPosition;

      if (tooltipHalfWidth <= spaceToLeft && tooltipHalfWidth <= spaceToRight) {
        // Center the tooltip over the icon if there's enough space on both sides
        newTooltipStyle.left = "50%";
        newTooltipStyle.transform = "translateX(-50%)";
        newArrowStyle.left = "50%";
        newArrowStyle.transform = "translateX(-50%)";
      } else if (spaceToRight < tooltipHalfWidth) {
        // Not enough space on the right, align tooltip to the right edge
        newTooltipStyle.right = "-20px";
        newTooltipStyle.left = "auto";

        const iconCenterFromRight = containerRect.width - iconCenterX;
        newArrowStyle.right = iconCenterFromRight + 10 + "px";
        newArrowStyle.left = "auto";
        newArrowStyle.transform = "none";
      } else {
        // Not enough space on the left, align tooltip to the left edge
        newTooltipStyle.left = "0";
        newTooltipStyle.right = "auto";

        // Position arrow to align with icon center
        newArrowStyle.left = iconCenterX + 5 + "px";
        newArrowStyle.right = "auto";
        newArrowStyle.transform = "none";
      }

      setTooltipStyle(newTooltipStyle);
      setArrowStyle(newArrowStyle);
    };

    // Calculate position initially and on changes
    calculatePosition();

    // Add resize and scroll event listeners
    window.addEventListener("resize", calculatePosition);
    window.addEventListener("scroll", calculatePosition);

    // Set up a MutationObserver to detect DOM changes
    const observer = new MutationObserver(calculatePosition);
    if (containerRef.current) {
      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        attributes: true
      });
    }

    return () => {
      window.removeEventListener("resize", calculatePosition);
      window.removeEventListener("scroll", calculatePosition);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative inline-block group overflow-visible ${className}`}
    >
      <div ref={iconRef} className="max-w-[245px]">
        <Icons.InfoCircle
          className={`size-${iconSize} ${iconColor} cursor-pointer`}
        />
      </div>
      <div
        ref={tooltipRef}
        style={tooltipStyle}
        className="
        absolute z-50
        bg-white border border-grey-80 rounded-[8px]
        px-2 py-2 text-[10px] font-medium text-grey-40 shadow-lg
        whitespace-normal break-words
        opacity-0 invisible group-hover:opacity-100 group-hover:visible
        transition-all duration-200
      "
      >
        {children}
        <div style={arrowStyle} />
      </div>
    </div>
  );
};

export default InfoTooltip;

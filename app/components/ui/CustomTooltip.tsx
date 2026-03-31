import { cn } from "@/app/lib/utils";
import React, { ReactNode, useRef, useState, useEffect } from "react";

interface CustomTooltipProps {
    children: ReactNode;
    tooltip: ReactNode;
    className?: string;
    tooltipClassName?: string;
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({
    children,
    tooltip,
    className = "",
    tooltipClassName = ""
}) => {
    const tooltipRef = useRef<HTMLDivElement>(null);
    const childRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
    const [arrowStyle, setArrowStyle] = useState<React.CSSProperties>({});
    const [shouldBeOnTop, setShouldBeOnTop] = useState<boolean>(false);

    useEffect(() => {
        const calculatePosition = () => {
            if (!tooltipRef.current || !childRef.current || !containerRef.current)
                return;

            const tooltipRect = tooltipRef.current.getBoundingClientRect();
            const childRect = childRef.current.getBoundingClientRect();
            const containerRect = containerRef.current.getBoundingClientRect();

            // Reset styles for accurate measurement
            setTooltipStyle({});

            // Get viewport dimensions
            const viewportWidth = window.innerWidth;

            // Calculate horizontal position
            const newTooltipStyle: React.CSSProperties = {
                maxWidth: "16.25rem",
                width: "max-content"
            };

            const newArrowStyle: React.CSSProperties = {
                position: "absolute",
                width: 0,
                height: 0
            };

            // Vertical positioning - check if there's enough space on top
            const spaceAbove = childRect.top;
            const shouldBeOnTop = spaceAbove >= tooltipRect.height;
            setShouldBeOnTop(shouldBeOnTop);

            if (shouldBeOnTop) {
                // Position above the icon
                newTooltipStyle.bottom = "100%";
                newTooltipStyle.marginBottom = "0.5rem";
                newArrowStyle.bottom = "-0.5rem";
                newArrowStyle.borderLeft = "8px solid transparent";
                newArrowStyle.borderRight = "8px solid transparent";
                newArrowStyle.borderTop = "8px solid white";
                newArrowStyle.zIndex = "10000";
                newArrowStyle.filter = "drop-shadow(0 2px 4px rgba(0,0,0,0.1))";
            } else {
                // Position below the icon
                newTooltipStyle.top = "100%";
                newTooltipStyle.marginTop = "0.5rem";
                newArrowStyle.top = "-0.5rem";
                newArrowStyle.borderLeft = "8px solid transparent";
                newArrowStyle.borderRight = "8px solid transparent";
                newArrowStyle.borderBottom = "8px solid white";
                newArrowStyle.zIndex = "10000";
                newArrowStyle.filter = "drop-shadow(0 -2px 4px rgba(0,0,0,0.1))";
            }

            // Get the absolute position of the icon center on screen
            const childCenterX = childRect.width / 2;
            const tooltipHalfWidth = tooltipRect.width / 2;

            // Calculate absolute positions considering the viewport
            const childCenterPosition = childRect.left + childCenterX;
            const spaceToLeft = childCenterPosition;
            const spaceToRight = viewportWidth - childCenterPosition;

            if (tooltipHalfWidth <= spaceToLeft && tooltipHalfWidth <= spaceToRight) {
                // Center the tooltip over the icon if there's enough space on both sides
                newTooltipStyle.left = "50%";
                newTooltipStyle.transform = "translateX(-50%)";
                newArrowStyle.left = "50%";
                newArrowStyle.transform = "translateX(-50%)";
            } else if (spaceToRight < tooltipHalfWidth) {
                // Not enough space on the right, align tooltip to the right edge
                newTooltipStyle.right = "-1.25rem";
                newTooltipStyle.left = "auto";

                const childCenterFromRight = containerRect.width - childCenterX;
                newArrowStyle.right = childCenterFromRight + 10 + "px";
                newArrowStyle.left = "auto";
                newArrowStyle.transform = "none";
            } else {
                // Not enough space on the left, align tooltip to the left edge
                newTooltipStyle.left = "0";
                newTooltipStyle.right = "auto";

                // Position arrow to align with icon center
                newArrowStyle.left = childCenterX + 5 + "px";
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
            className={cn("relative inline-block group overflow-visible", className)}
        >
            <div ref={childRef} className="inline-flex">
                {children}
            </div>
            <div
                ref={tooltipRef}

                className={cn("absolute z-[9999] bg-white border border-grey-80 rounded-lg px-2 py-2 text-[0.625rem] font-medium text-grey-40 whitespace-normal break-words opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200", tooltipClassName)}
                style={{
                    ...tooltipStyle,
                    boxShadow: shouldBeOnTop ? '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)' : '0 -4px 6px -1px rgba(0, 0, 0, 0.1), 0 -2px 4px -1px rgba(0, 0, 0, 0.06)'
                }}
            >
                {tooltip}
                <div style={arrowStyle} />
            </div>
        </div>
    );
};

export default CustomTooltip;

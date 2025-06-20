import type { CSSProperties } from "react";

export function getTooltipStyle(
  position: { x: number; y: number },
  windowWidth: number,
  windowHeight: number,
  tooltipWidth = 260,
  tooltipHeight = 200,
  padding = 2
): CSSProperties {
  const { x, y } = position;
  const isMobile = windowWidth <= 640;

  const style: CSSProperties = {
    position: "fixed",
    top: Math.min(y, windowHeight - tooltipHeight - padding),
    zIndex: 999999,
    pointerEvents: "auto",
  };

  if (isMobile) {
    style.left = Math.max(
      Math.min(x - tooltipWidth / 2, windowWidth - tooltipWidth - padding),
      padding
    );
    return style;
  }

  const spaceRight = windowWidth - x;
  if (spaceRight > tooltipWidth + padding) {
    style.left = x + padding;
  } else {
    style.left = Math.max(x - tooltipWidth - padding, padding);
  }

  return style;
}

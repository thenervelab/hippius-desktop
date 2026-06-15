export interface DiagonalTextureOptions {
  color?: string;
  gap?: number;
  lineWidth?: number;
}

export interface DiagonalTextureSvgOptions {
  color?: string;
  opacity?: number;
  size?: number;
  lineWidth?: number;
}

export const DEFAULT_DIAGONAL_TEXTURE_LINE_GAP = 10;
export const DEFAULT_DIAGONAL_TEXTURE_LINE_WIDTH = 0.5;

export const getDiagonalTextureBackgroundImage = ({
  color = "rgba(0, 0, 0, 0.13)",
  gap = DEFAULT_DIAGONAL_TEXTURE_LINE_GAP,
  lineWidth = DEFAULT_DIAGONAL_TEXTURE_LINE_WIDTH,
}: DiagonalTextureOptions = {}) => {
  const safeLineWidth = Math.max(lineWidth, 0.5);
  const safeGap = Math.max(gap, 0);
  const patternSize = safeLineWidth + safeGap;

  return `repeating-linear-gradient(135deg, ${color} 0px, ${color} ${safeLineWidth}px, transparent ${safeLineWidth}px, transparent ${patternSize}px)`;
};

const buildDiagonalTextureSvg = ({
  color = "black",
  opacity = 0.13,
  size = 4,
  lineWidth = 0.363636,
}: DiagonalTextureSvgOptions = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
<path d="M${size} 0L0 ${size}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${lineWidth}"/>
</svg>`;

export const getDiagonalTextureSvgBackgroundImage = (
  options: DiagonalTextureSvgOptions = {},
) =>
  `url("data:image/svg+xml,${encodeURIComponent(buildDiagonalTextureSvg(options))}")`;

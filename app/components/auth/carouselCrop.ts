export type FrameSize = {
  width: number;
  height: number;
};

export const computeCropLockScale = (
  base: FrameSize | null,
  current: FrameSize,
): number => {
  if (!base) return 1;
  if (base.width <= 0 || base.height <= 0) return 1;
  if (current.width <= 0 || current.height <= 0) return 1;
  return (current.width * base.height) / (base.width * current.height);
};

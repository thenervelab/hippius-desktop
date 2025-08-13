import { Rgb } from "@/lib/types";
import { lerpBetweeenRGB } from "./lerp";

export const getPercentageColor = (percentage: number, inverse?: boolean) => {
  const green: Rgb = [8, 200, 113];
  const red: Rgb = [255, 112, 102];

  const colorA = inverse ? green : red;
  const colorB = inverse ? red : green;
  const color = lerpBetweeenRGB(colorA, colorB, percentage / 100);

  return `rgb(${color.join()})`;
};

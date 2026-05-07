import { cn } from "@/lib/utils";

interface BackgroundHippoProps extends React.SVGProps<SVGSVGElement> {
  strokeClassName?: string;
  fillClassName?: string;
}

export function BackgroundHippo({
  strokeClassName = "stroke-[#6c6c6c] dark:stroke-white",
  fillClassName = "fill-white dark:fill-[#303030]",
  ...props
}: BackgroundHippoProps) {
  return (
    <svg viewBox="0 0 22 21" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="1" width="21" height="21" fill="black" fillOpacity="0.05" />
      <rect x="1.5" y="0.5" width="20" height="20" stroke="black" strokeOpacity="0.26" />
      <g filter="url(#filter0_dddd)">
        <rect x="5" y="4" width="13" height="13" className={cn(fillClassName)} />
      </g>
      <defs>
        <filter
          id="filter0_dddd"
          x="0"
          y="3"
          width="23"
          height="32"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.23 0"
          />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
      </defs>
    </svg>
  );
}

import { useId } from "react";
import { IconComponent } from "@/app/lib/types";

/**
 * 12×12 "file with plus" glyph used inside the small blue badge on the
 * Import-Wallet drop zone (empty state). `currentColor` so the parent
 * controls fill via Tailwind `text-*` utilities, matching how the
 * other vector icons in this folder are themed.
 */
const FilePlus: IconComponent = (props) => {
  const rawId = useId();
  const clipId = `file-plus-clip-${rawId.replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath={`url(#${clipId})`}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M1.93934 0.93934C2.22064 0.658035 2.60218 0.5 3 0.5H7.5C7.63261 0.5 7.75979 0.552678 7.85355 0.646447L10.3536 3.14645C10.4473 3.24021 10.5 3.36739 10.5 3.5V10C10.5 10.3978 10.342 10.7794 10.0607 11.0607C9.77936 11.342 9.39783 11.5 9 11.5H2C1.72386 11.5 1.5 11.2761 1.5 11C1.5 10.7239 1.72386 10.5 2 10.5H9C9.13261 10.5 9.25978 10.4473 9.35355 10.3536C9.44732 10.2598 9.5 10.1326 9.5 10V3.70711L7.29289 1.5H3C2.86739 1.5 2.74021 1.55268 2.64645 1.64645C2.55268 1.74021 2.5 1.86739 2.5 2V4C2.5 4.27614 2.27614 4.5 2 4.5C1.72386 4.5 1.5 4.27614 1.5 4V2C1.5 1.60218 1.65804 1.22064 1.93934 0.93934Z"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M7 0.5C7.27614 0.5 7.5 0.723858 7.5 1V3C7.5 3.13261 7.55268 3.25979 7.64645 3.35355C7.74021 3.44732 7.86739 3.5 8 3.5H10C10.2761 3.5 10.5 3.72386 10.5 4C10.5 4.27614 10.2761 4.5 10 4.5H8C7.60218 4.5 7.22064 4.34196 6.93934 4.06066C6.65804 3.77936 6.5 3.39783 6.5 3V1C6.5 0.723858 6.72386 0.5 7 0.5Z"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M1 7.5C1 7.22386 1.22386 7 1.5 7H4.5C4.77614 7 5 7.22386 5 7.5C5 7.77614 4.77614 8 4.5 8H1.5C1.22386 8 1 7.77614 1 7.5Z"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M3 5.5C3.27614 5.5 3.5 5.72386 3.5 6V9C3.5 9.27614 3.27614 9.5 3 9.5C2.72386 9.5 2.5 9.27614 2.5 9V6C2.5 5.72386 2.72386 5.5 3 5.5Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id={clipId}>
          <rect width="12" height="12" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default FilePlus;

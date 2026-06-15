import { IconComponent } from "@/app/lib/types";

/* 16×16 horizontal two-way arrow — used on the wallet "Bridge
   Tokens" CTA. Strokes paint in `currentColor` so the button theme
   propagates. */
export const BridgeArrows: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    {...props}
  >
    <path
      d="M5.33268 7.33333L2.66602 4.66667L5.33268 2M2.66602 4.66667H13.3327M10.666 8.66667L13.3327 11.3333L10.666 14M13.3327 11.3333H2.66602"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default BridgeArrows;

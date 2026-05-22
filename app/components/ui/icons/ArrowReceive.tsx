import { IconComponent } from "@/app/lib/types";

/* 7×7 arrow heading into the bottom-left corner — paired with the
   wallet "Receive" CTA. Strokes paint in `currentColor` so the button
   theme propagates (white-on-blue for primary, etc.). */
export const ArrowReceive: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 7 7"
    fill="none"
    {...props}
  >
    <path
      d="M5.7041 5.71558L0.700309 5.71558L0.70031 0.699989"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M0.702148 5.70947L5.70215 0.709474"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default ArrowReceive;

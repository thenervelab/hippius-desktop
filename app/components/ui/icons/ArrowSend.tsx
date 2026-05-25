import { IconComponent } from "@/app/lib/types";

/* 7×7 arrow heading out to the top-right corner — paired with the
   wallet "Send" CTA. Strokes paint in `currentColor` so the button
   theme propagates (white-on-blue for primary, etc.). */
export const ArrowSend: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 7 7"
    fill="none"
    {...props}
  >
    <path
      d="M1.01465 0.699951H6.01844V5.71554"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M5.7002 1.03979L0.700195 6.0398"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default ArrowSend;

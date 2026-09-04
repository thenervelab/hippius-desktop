import { IconComponent } from "@/app/lib/types";

// The "Pricing - Drive" sidebar icon from the design system (vuesax linear
// card): a payment card with a top stripe and two detail dashes. Stroke-based
// so it inherits `currentColor` like every sibling icon.
export const PricingCard: IconComponent = (props) => (
  <svg
    viewBox="0 0 18 18"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M1.5 6.375H16.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeMiterlimit="10"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4.5 12.375H6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeMiterlimit="10"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7.875 12.375H10.875"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeMiterlimit="10"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4.83 2.625H13.1625C15.8325 2.625 16.5 3.285 16.5 5.9175V12.075C16.5 14.7075 15.8325 15.3675 13.17 15.3675H4.83C2.1675 15.375 1.5 14.715 1.5 12.0825V5.9175C1.5 3.285 2.1675 2.625 4.83 2.625Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default PricingCard;

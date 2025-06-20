import { IconComponent } from "@/app/lib/types";

export const InfoCircle: IconComponent = (props) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M10.0001 18.3327C14.5834 18.3327 18.3334 14.5827 18.3334 9.99935C18.3334 5.41602 14.5834 1.66602 10.0001 1.66602C5.41675 1.66602 1.66675 5.41602 1.66675 9.99935C1.66675 14.5827 5.41675 18.3327 10.0001 18.3327Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10 6.66602V10.8327"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.99536 13.334H10.0028"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default InfoCircle;

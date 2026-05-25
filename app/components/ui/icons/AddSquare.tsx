import { IconComponent } from "@/app/lib/types";

export const AddSquare: IconComponent = (props) => (
  <svg
    viewBox="0 0 30 30"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M10.2 15H19.8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M15 19.8002V10.2002"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.4 27H18.6C24.6 27 27 24.6 27 18.6V11.4C27 5.4 24.6 3 18.6 3H11.4C5.4 3 3 5.4 3 11.4V18.6C3 24.6 5.4 27 11.4 27Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default AddSquare;

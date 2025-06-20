import { IconComponent } from "@/app/lib/types";

export const Clock: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 17 16"
    fill="none"
    {...props}
  >
    <path
      d="M15.0931 8C15.0931 11.68 12.1064 14.6667 8.42643 14.6667C4.74643 14.6667 1.75977 11.68 1.75977 8C1.75977 4.32 4.74643 1.33333 8.42643 1.33333C12.1064 1.33333 15.0931 4.32 15.0931 8Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10.8998 10.12L8.83314 8.88667C8.47314 8.67333 8.17981 8.16 8.17981 7.74V5.00667"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default Clock;

import { IconComponent } from "@/app/lib/types";

export const Seperator: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 8 8"
    fill="none"
    {...props}
  >
    <rect
      y="4"
      width="6"
      height="6"
      rx="2"
      transform="rotate(-45 0 4)"
      fill="currentColor"
      fillOpacity="0.4"
    />
  </svg>
);

export default Seperator;

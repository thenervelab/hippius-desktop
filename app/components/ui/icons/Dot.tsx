import { IconComponent } from "@/app/lib/types";

export const Dot: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    {...props}
    viewBox="0 0 4 4"
    fill="none"
  >
    <circle
      cx="2"
      cy="2"
      r="1.8"
      fill="#D3DFF8"
      stroke="#1F51BE"
      strokeWidth="0.4"
    />
  </svg>
);

export default Dot;

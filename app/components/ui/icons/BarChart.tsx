import { IconComponent } from "@/app/lib/types";

/* Three vertical bars at increasing heights — used as the "balance"
   header glyph on the wallet page next to the MY BALANCE label. Bars
   render in `currentColor` so callers theme via Tailwind `text-*`
   classes (primary blue in light, brand-dark in dark). */
export const BarChart: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 18 16"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13.5 6C13.9142 6 14.25 6.29848 14.25 6.66667V13.3333C14.25 13.7015 13.9142 14 13.5 14C13.0858 14 12.75 13.7015 12.75 13.3333V6.66667C12.75 6.29848 13.0858 6 13.5 6Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9 2C9.41421 2 9.75 2.29848 9.75 2.66667V13.3333C9.75 13.7015 9.41421 14 9 14C8.58579 14 8.25 13.7015 8.25 13.3333V2.66667C8.25 2.29848 8.58579 2 9 2Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4.5 8.66675C4.91421 8.66675 5.25 8.96522 5.25 9.33341V13.3334C5.25 13.7016 4.91421 14.0001 4.5 14.0001C4.08579 14.0001 3.75 13.7016 3.75 13.3334V9.33341C3.75 8.96522 4.08579 8.66675 4.5 8.66675Z"
      fill="currentColor"
    />
  </svg>
);

export default BarChart;

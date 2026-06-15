import { IconComponent } from "@/app/lib/types";

/* 14×14 dollar-in-circle with an outward arrow on the top-right —
   used on the wallet "Unstake hAlpha" CTA. Strokes paint in
   `currentColor` so the button theme propagates. */
export const UnstakeHalpha: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 14 14"
    fill="none"
    {...props}
  >
    <path
      d="M5.54199 8.01975C5.54199 8.58558 5.9795 9.04058 6.51617 9.04058H7.61282C8.07948 9.04058 8.45866 8.64391 8.45866 8.14808C8.45866 7.61725 8.22533 7.42475 7.88116 7.30225L6.12533 6.68975C5.78116 6.56725 5.54783 6.38058 5.54783 5.84392C5.54783 5.35392 5.92699 4.95142 6.39365 4.95142H7.49032C8.02699 4.95142 8.4645 5.40642 8.4645 5.97225"
      stroke="currentColor"
      strokeWidth="1.16667"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7.00098 4.375V9.625"
      stroke="currentColor"
      strokeWidth="1.16667"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12.8337 7.00008C12.8337 10.2201 10.2203 12.8334 7.00033 12.8334C3.78033 12.8334 1.16699 10.2201 1.16699 7.00008C1.16699 3.78008 3.78033 1.16675 7.00033 1.16675"
      stroke="currentColor"
      strokeWidth="1.16667"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12.8291 3.50464L12.8408 1.17133L10.5075 1.15959"
      stroke="currentColor"
      strokeWidth="1.16667"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.90954 4.0759L12.8408 1.17395"
      stroke="currentColor"
      strokeWidth="1.16667"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default UnstakeHalpha;

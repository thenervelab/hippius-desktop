import { IconComponent } from "@/app/lib/types";

const QuestionCircle: IconComponent = (props) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M10.0001 18.3327C14.5834 18.3327 18.3334 14.5827 18.3334 9.99935C18.3334 5.41602 14.5834 1.66602 10.0001 1.66602C5.41675 1.66602 1.66675 5.41602 1.66675 9.99935C1.66675 14.5827 5.41675 18.3327 10.0001 18.3327Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7.5752 7.49999C7.7709 6.94304 8.16171 6.47341 8.67485 6.17426C9.18799 5.87512 9.78888 5.76577 10.3728 5.86558C10.9566 5.96539 11.4848 6.26792 11.8656 6.71959C12.2465 7.17126 12.4546 7.74292 12.4527 8.33332C12.4527 9.99999 9.95271 10.8333 9.95271 10.8333"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="10" cy="14.167" r="0.833" fill="currentColor" />
  </svg>
);

export default QuestionCircle;

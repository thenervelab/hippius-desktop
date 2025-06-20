import { IconComponent } from "@/app/lib/types";

export const Triangle: IconComponent = (props) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M10 17.5286H5.15204C2.37604 17.5286 1.21604 15.5446 2.56004 13.1206L5.05604 8.62461L7.40804 4.40061C8.83204 1.83261 11.168 1.83261 12.592 4.40061L14.944 8.63261L17.44 13.1286C18.784 15.5526 17.616 17.5366 14.848 17.5366H10V17.5286Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M17.552 16.4003L10 11.1123L2.448 16.4003"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10 2.80078V11.1128"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default Triangle;

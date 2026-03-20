import { IconComponent } from "@/app/lib/types";

export const CircularTickGrid: IconComponent = (props) => (
    <svg
        width="36"
        height="36"
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        {...props}
    >
        <rect width="36" height="36" rx="18" fill="#D3DFF8" />
        <g opacity="0.5">
            <g clipPath="url(#clip0_22082_277772)">
                <rect
                    width="36"
                    height="36"
                    fill="white"
                    stroke="#B4C8F3"
                    strokeWidth="0.7"
                />
                <path d="M0 0L36 36" stroke="#B4C8F3" strokeWidth="0.7" />
                <path d="M0 36L36 1.28741e-06" stroke="#B4C8F3" strokeWidth="0.7" />
                <path d="M18 0V36" stroke="#B4C8F3" strokeWidth="0.7" />
                <path d="M0 18H36" stroke="#B4C8F3" strokeWidth="0.7" />
                <rect
                    x="2.25"
                    y="6.75"
                    width="31.5"
                    height="22.5"
                    rx="1"
                    stroke="#B4C8F3"
                    strokeWidth="0.7"
                />
                <rect
                    x="4.5"
                    y="4.5"
                    width="27"
                    height="27"
                    rx="1"
                    stroke="#B4C8F3"
                    strokeWidth="0.7"
                />
                <rect
                    x="6.75"
                    y="33.75"
                    width="31.5"
                    height="22.5"
                    rx="1"
                    transform="rotate(-90 6.75 33.75)"
                    stroke="#B4C8F3"
                    strokeWidth="0.7"
                />
                <circle cx="18" cy="18" r="15.75" stroke="#B4C8F3" strokeWidth="0.7" />
                <circle cx="18" cy="18" r="6.75" stroke="#B4C8F3" strokeWidth="0.7" />
            </g>
        </g>
        <path
            d="M18 28C23.5 28 28 23.5 28 18C28 12.5 23.5 8 18 8C12.5 8 8 12.5 8 18C8 23.5 12.5 28 18 28Z"
            stroke="#1F51BE"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <path
            d="M13.75 18.0019L16.58 20.8319L22.25 15.1719"
            stroke="#1F51BE"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <defs>
            <clipPath id="clip0_22082_277772">
                <rect width="36" height="36" rx="18" fill="white" />
            </clipPath>
        </defs>
    </svg>
);

export default CircularTickGrid;

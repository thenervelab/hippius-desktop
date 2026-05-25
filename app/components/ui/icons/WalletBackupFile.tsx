import { useId } from "react";
import { IconComponent } from "@/app/lib/types";

/**
 * 78×94 file-thumbnail used when the user has selected a wallet
 * backup file in the import drop zone. Mirrors the source Figma
 * export (`Group 2087327826.svg`) — main file body, gradient stroke
 * border, folded corner, three placeholder text bars, and the small
 * blue badge. The badge originally read "csv" (Figma boilerplate);
 * we now render "ZIP" via an SVG `<text>` element instead of the
 * baked-in glyph paths so the label tracks the actual export
 * format and is trivial to retheme later. The Figma drop-shadow
 * filter and the backdrop-blur foreignObject were dropped (filter
 * IDs need to be unique per instance and `backdrop-filter` inside
 * SVG is Chrome-only); the shadow can be reapplied with a Tailwind
 * `shadow-*` class on the wrapper if desired.
 *
 * Dark mode is handled by mode-specific class overrides on the
 * caller's wrapper — the icon itself paints the Figma light-mode
 * colours and leaves theming to the caller.
 */
const WalletBackupFile: IconComponent = (props) => {
  const rawId = useId();
  const gradId = `wbf-grad-${rawId.replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 78 94"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M1.47754 7.47493C1.47754 3.34664 4.82418 0 8.95247 0H49.5303C51.5387 0 53.4626 0.808178 54.8684 2.24242L64.3349 11.8999L74.0393 21.6108C75.44 23.0125 76.2269 24.913 76.2269 26.8946V41.6498V82.6247C76.2269 86.753 72.8802 90.0996 68.7519 90.0996H8.95247C4.82418 90.0996 1.47754 86.753 1.47754 82.6247V7.47493Z"
        fill="white"
        fillOpacity="0.97"
      />
      <path
        d="M8.95215 0.287109H49.5303C51.4613 0.287109 53.3113 1.06439 54.6631 2.44336L64.1299 12.1016L64.1318 12.1035L73.8359 21.8145C75.1826 23.1622 75.9394 24.9893 75.9395 26.8945V82.625C75.9393 86.5944 72.7213 89.8125 68.752 89.8125H8.95215C4.98289 89.8123 1.76482 86.5943 1.76465 82.625V7.47461C1.76482 3.50535 4.98289 0.287284 8.95215 0.287109Z"
        stroke={`url(#${gradId})`}
        strokeWidth="0.574995"
      />
      <path
        d="M74.6155 24.0266H54.5002C53.2299 24.0266 52.2002 22.9968 52.2002 21.7266V1.61126C52.2002 1.01666 52.9191 0.718889 53.3395 1.13933L75.0874 22.8872C75.5079 23.3077 75.2101 24.0266 74.6155 24.0266Z"
        fill="#727272"
        fillOpacity="0.12"
      />
      <rect
        opacity="0.15"
        x="18.7266"
        y="28.6631"
        width="10.6785"
        height="2.66962"
        rx="1.33481"
        fill="#1B1B1B"
      />
      <rect
        opacity="0.1"
        x="18.7266"
        y="34.0023"
        width="40.7117"
        height="2.66962"
        rx="1.33481"
        fill="#727272"
      />
      <rect
        opacity="0.1"
        x="18.7266"
        y="39.3415"
        width="40.7117"
        height="2.66962"
        rx="1.33481"
        fill="#727272"
      />
      <path
        d="M21.7773 71.5805C21.7773 68.8594 23.9833 66.6535 26.7044 66.6535H52.3929C55.114 66.6535 57.32 68.8594 57.32 71.5805V78.9592C57.32 81.6803 55.114 83.8863 52.3929 83.8863H26.7044C23.9833 83.8863 21.7773 81.6803 21.7773 78.9592V71.5805Z"
        fill="#3167DD"
        fillOpacity="0.1"
      />
      <text
        x="39.55"
        y="78.85"
        textAnchor="middle"
        fill="#3167DD"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontWeight="700"
        fontSize="7.2"
        letterSpacing="0.4"
      >
        ZIP
      </text>
      <defs>
        <linearGradient
          id={gradId}
          x1="38.8522"
          y1="0"
          x2="38.8522"
          y2="90.0996"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#E3E3E3" />
          <stop offset="1" stopColor="#C9C9C9" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export default WalletBackupFile;

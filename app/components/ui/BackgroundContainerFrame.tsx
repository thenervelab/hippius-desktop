import { useId } from "react";

interface BackgroundContainerFrameProps extends React.SVGProps<SVGSVGElement> {
  tone?: "default" | "dark";
  pageStyle?: boolean;
}

export function BackgroundContainerFrame({
  tone = "default",
  pageStyle = false,
  ...props
}: BackgroundContainerFrameProps) {
  const id = useId().replace(/:/g, "_");
  const patternId = `${id}_pattern`;
  const patternInnerId = `${id}_pattern_inner`;
  const isDark = tone === "dark";
  const baseFill = isDark ? "#1A1A1A" : "#F2F2F2";
  const baseFillOpacity = isDark ? 1 : 0.42;
  const patternStroke = isDark ? "#FFFFFF" : "#000000";
  const frameStroke = isDark && !pageStyle ? "#353535" : isDark ? "#535353" : "#CACACA";
  const cornerFill = isDark && !pageStyle ? "#202020" : isDark ? "#333333" : "#ADADAD";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 581 692"
      preserveAspectRatio="none"
      fill="none"
      {...props}
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          patternTransform="matrix(4 0 0 4 -0.128906 -0.12854)"
          preserveAspectRatio="none"
          viewBox="-0.128906 -0.12854 4 4"
          width="1"
          height="1"
        >
          <use href={`#${patternInnerId}`} transform="translate(-4 -4)" />
          <use href={`#${patternInnerId}`} transform="translate(0 -4)" />
          <use href={`#${patternInnerId}`} transform="translate(-4 0)" />
          <g id={patternInnerId}>
            <path d="M4 0L0 4" stroke={patternStroke} strokeWidth="0.363636" />
          </g>
        </pattern>
      </defs>
      <rect width="581" height="692" fill={baseFill} fillOpacity={baseFillOpacity} />
      <rect width="581" height="692" fill={`url(#${patternId})`} fillOpacity={0.21} />
      <rect x="0.5" y="0.5" width="580" height="691" stroke={frameStroke} />
      {/* Bottom-left corner bracket */}
      <path
        d="M0 692H-1V693H0V692ZM34.1765 692V691H0V692V693H34.1765V692ZM0 692H1V651.294H0H-1V692H0Z"
        fill={cornerFill}
      />
      {/* Bottom-right corner bracket */}
      <path
        d="M581 692L581 693L582 693L582 692L581 692ZM581 651.294L580 651.294L580 692L581 692L582 692L582 651.294L581 651.294ZM581 692L581 691L546.823 691L546.823 692L546.823 693L581 693L581 692Z"
        fill={cornerFill}
      />
      {/* Top-left corner bracket */}
      <path
        d="M0 5.72205e-05H-1V-0.999943H0V5.72205e-05ZM34.1765 5.72205e-05V1.00006H0V5.72205e-05V-0.999943H34.1765V5.72205e-05ZM0 5.72205e-05H1V40.7059H0H-1V5.72205e-05H0Z"
        fill={cornerFill}
      />
      {/* Top-right corner bracket */}
      <path
        d="M581 1.52979e-06L581 -0.999998L582 -0.999998L582 1.57456e-06L581 1.52979e-06ZM581 40.7059L580 40.7059L580 1.48503e-06L581 1.52979e-06L582 1.57456e-06L582 40.7059L581 40.7059ZM581 1.52979e-06L581 1L546.823 1L546.823 0L546.823 -1L581 -0.999998L581 1.52979e-06Z"
        fill={cornerFill}
      />
    </svg>
  );
}

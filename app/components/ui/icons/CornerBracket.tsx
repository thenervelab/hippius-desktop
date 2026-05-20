import { IconComponent } from "@/app/lib/types";

/* Corner-bracket glyph family used by the wallet page (and any other
 * "framed table" surface) to draw the visible joinery where two
 * dividers meet. Each variant is a 6×9 (or 9×9 for the T/+ variants)
 * SVG using `currentColor` so callers control the line tone via
 * Tailwind text-* classes. */

export const CornerBracket: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="6"
    height="9"
    viewBox="0 0 6 9"
    fill="none"
    {...props}
  >
    <path
      d="M0.00165057 9V0H1.16901V9H0.00165057ZM0 5.08368V3.93515H5.08533V5.08368H0Z"
      fill="currentColor"
    />
  </svg>
);

export default CornerBracket;

export const CornerBracketFlipped: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="6"
    height="9"
    viewBox="0 0 6 9"
    fill="none"
    {...props}
  >
    <path
      d="M5.0838 9V0H3.91643V9H5.0838ZM5.08545 5.08368V3.93515H0.000116348V5.08368H5.08545Z"
      fill="currentColor"
    />
  </svg>
);

/** T pointing up (⊥) — horizontal bar + upward arm only. */
export const CornerBracketUp: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="9"
    height="9"
    viewBox="0 0 9 9"
    fill="none"
    {...props}
  >
    <path
      d="M3.916 0V3.935H5.084V0H3.916ZM0 3.935V5.084H9V3.935H0Z"
      fill="currentColor"
    />
  </svg>
);

/** T pointing down (⊤) — horizontal bar + downward arm only. */
export const CornerBracketDown: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="9"
    height="9"
    viewBox="0 0 9 9"
    fill="none"
    {...props}
  >
    <path
      d="M0 3.935V5.084H9V3.935H0ZM3.916 5.084V9H5.084V5.084H3.916Z"
      fill="currentColor"
    />
  </svg>
);

/** Plus / cross intersection — both arms. */
export const PlusCrossIcon: IconComponent = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="9"
    height="9"
    viewBox="0 0 9 9"
    fill="none"
    {...props}
  >
    <path
      d="M3.916 0V9H5.084V0H3.916ZM0 3.935V5.084H9V3.935H0Z"
      fill="currentColor"
    />
  </svg>
);

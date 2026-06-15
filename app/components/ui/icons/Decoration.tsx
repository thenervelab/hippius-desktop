import { IconComponent } from "@/app/lib/types";

/**
 * 56×56 brand-blue grid decoration behind logo badges (update dialog
 * header etc).
 *
 * Two rendering paths share one cell grid via the local `CellGrid`
 * helper, mode-swapped with Tailwind `dark:` classes:
 *
 *  - Light mode mirrors the original `Decoration.svg`: the full 4×4 grid
 *    extends out to the corners, with a radial-white gradient overlay
 *    that softly fades the strokes back into the white card surface
 *    near the edges. Corners stay visibly part of the decoration so the
 *    badge sits inside a "blueprint" frame, just like the source SVG.
 *  - Dark mode mirrors the matching dark variant: an alpha mask shaped
 *    as a Gaussian-blurred ellipse crops the grid to a sparse central
 *    oval where only the inner ~2×2 cells stay fully opaque. The dark
 *    card surface shows through everywhere the mask hides.
 *
 * Cell strokes are #1F50BD (brand primary) in both modes; the 5%-opacity
 * white interior pattern stays the same. Only the surrounding
 * fade-to-surface treatment differs.
 */

const CellGrid = () => (
  <g opacity="0.7">
    <g clipPath="url(#decoration-clip0)">
      <path
        opacity="0.05"
        d="M-2.56 -3.8L-2.56 12.2M-0.959999 -4L-0.96 12M0.64 -4L0.639999 12M2.24 -4L2.24 12M3.84 -4L3.84 12M5.44 -4L5.44 12M7.04 -4L7.04 12M8.64 -4L8.64 12M10.24 -4V12M-4 -2.44H12M-4 -0.84H12M-4 0.76H12M-4 2.36H12M-4 3.96H12M-4 5.56H12M-4 7.16H12M-4 8.76H12M-4 10.36H12"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="-4" y="-4" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip1)">
      <path
        opacity="0.05"
        d="M13.44 -3.8L13.44 12.2M15.04 -4L15.04 12M16.64 -4L16.64 12M18.24 -4L18.24 12M19.84 -4L19.84 12M21.44 -4L21.44 12M23.04 -4L23.04 12M24.64 -4L24.64 12M26.24 -4V12M12 -2.44H28M12 -0.84H28M12 0.76H28M12 2.36H28M12 3.96H28M12 5.56H28M12 7.16H28M12 8.76H28M12 10.36H28"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="12" y="-4" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip2)">
      <path
        opacity="0.05"
        d="M29.44 -3.8L29.44 12.2M31.04 -4L31.04 12M32.64 -4L32.64 12M34.24 -4L34.24 12M35.84 -4L35.84 12M37.44 -4L37.44 12M39.04 -4L39.04 12M40.64 -4L40.64 12M42.24 -4V12M28 -2.44H44M28 -0.84H44M28 0.76H44M28 2.36H44M28 3.96H44M28 5.56H44M28 7.16H44M28 8.76H44M28 10.36H44"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="28" y="-4" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip3)">
      <path
        opacity="0.05"
        d="M45.44 -3.8L45.44 12.2M47.04 -4L47.04 12M48.64 -4L48.64 12M50.24 -4L50.24 12M51.84 -4L51.84 12M53.44 -4L53.44 12M55.04 -4L55.04 12M56.64 -4L56.64 12M58.24 -4V12M44 -2.44H60M44 -0.84H60M44 0.76H60M44 2.36H60M44 3.96H60M44 5.56H60M44 7.16H60M44 8.76H60M44 10.36H60"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="44" y="-4" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip4)">
      <path
        opacity="0.05"
        d="M-2.56 12.2L-2.56 28.2M-0.959999 12L-0.96 28M0.64 12L0.639999 28M2.24 12L2.24 28M3.84 12L3.84 28M5.44 12L5.44 28M7.04 12L7.04 28M8.64 12L8.64 28M10.24 12V28M-4 13.56H12M-4 15.16H12M-4 16.76H12M-4 18.36H12M-4 19.96H12M-4 21.56H12M-4 23.16H12M-4 24.76H12M-4 26.36H12"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="-4" y="12" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip5)">
      <path
        opacity="0.05"
        d="M13.44 12.2L13.44 28.2M15.04 12L15.04 28M16.64 12L16.64 28M18.24 12L18.24 28M19.84 12L19.84 28M21.44 12L21.44 28M23.04 12L23.04 28M24.64 12L24.64 28M26.24 12V28M12 13.56H28M12 15.16H28M12 16.76H28M12 18.36H28M12 19.96H28M12 21.56H28M12 23.16H28M12 24.76H28M12 26.36H28"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="12" y="12" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip6)">
      <path
        opacity="0.05"
        d="M29.44 12.2L29.44 28.2M31.04 12L31.04 28M32.64 12L32.64 28M34.24 12L34.24 28M35.84 12L35.84 28M37.44 12L37.44 28M39.04 12L39.04 28M40.64 12L40.64 28M42.24 12V28M28 13.56H44M28 15.16H44M28 16.76H44M28 18.36H44M28 19.96H44M28 21.56H44M28 23.16H44M28 24.76H44M28 26.36H44"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="28" y="12" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip7)">
      <path
        opacity="0.05"
        d="M45.44 12.2L45.44 28.2M47.04 12L47.04 28M48.64 12L48.64 28M50.24 12L50.24 28M51.84 12L51.84 28M53.44 12L53.44 28M55.04 12L55.04 28M56.64 12L56.64 28M58.24 12V28M44 13.56H60M44 15.16H60M44 16.76H60M44 18.36H60M44 19.96H60M44 21.56H60M44 23.16H60M44 24.76H60M44 26.36H60"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="44" y="12" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip8)">
      <path
        opacity="0.05"
        d="M-2.56 28.2L-2.56 44.2M-0.959999 28L-0.96 44M0.64 28L0.639999 44M2.24 28L2.24 44M3.84 28L3.84 44M5.44 28L5.44 44M7.04 28L7.04 44M8.64 28L8.64 44M10.24 28V44M-4 29.56H12M-4 31.16H12M-4 32.76H12M-4 34.36H12M-4 35.96H12M-4 37.56H12M-4 39.16H12M-4 40.76H12M-4 42.36H12"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="-4" y="28" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip9)">
      <path
        opacity="0.05"
        d="M13.44 28.2L13.44 44.2M15.04 28L15.04 44M16.64 28L16.64 44M18.24 28L18.24 44M19.84 28L19.84 44M21.44 28L21.44 44M23.04 28L23.04 44M24.64 28L24.64 44M26.24 28V44M12 29.56H28M12 31.16H28M12 32.76H28M12 34.36H28M12 35.96H28M12 37.56H28M12 39.16H28M12 40.76H28M12 42.36H28"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="12" y="28" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip10)">
      <path
        opacity="0.05"
        d="M29.44 28.2L29.44 44.2M31.04 28L31.04 44M32.64 28L32.64 44M34.24 28L34.24 44M35.84 28L35.84 44M37.44 28L37.44 44M39.04 28L39.04 44M40.64 28L40.64 44M42.24 28V44M28 29.56H44M28 31.16H44M28 32.76H44M28 34.36H44M28 35.96H44M28 37.56H44M28 39.16H44M28 40.76H44M28 42.36H44"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="28" y="28" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip11)">
      <path
        opacity="0.05"
        d="M45.44 28.2L45.44 44.2M47.04 28L47.04 44M48.64 28L48.64 44M50.24 28L50.24 44M51.84 28L51.84 44M53.44 28L53.44 44M55.04 28L55.04 44M56.64 28L56.64 44M58.24 28V44M44 29.56H60M44 31.16H60M44 32.76H60M44 34.36H60M44 35.96H60M44 37.56H60M44 39.16H60M44 40.76H60M44 42.36H60"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="44" y="28" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip12)">
      <path
        opacity="0.05"
        d="M-2.56 44.2L-2.56 60.2M-0.959999 44L-0.96 60M0.64 44L0.639999 60M2.24 44L2.24 60M3.84 44L3.84 60M5.44 44L5.44 60M7.04 44L7.04 60M8.64 44L8.64 60M10.24 44V60M-4 45.56H12M-4 47.16H12M-4 48.76H12M-4 50.36H12M-4 51.96H12M-4 53.56H12M-4 55.16H12M-4 56.76H12M-4 58.36H12"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="-4" y="44" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip13)">
      <path
        opacity="0.05"
        d="M13.44 44.2L13.44 60.2M15.04 44L15.04 60M16.64 44L16.64 60M18.24 44L18.24 60M19.84 44L19.84 60M21.44 44L21.44 60M23.04 44L23.04 60M24.64 44L24.64 60M26.24 44V60M12 45.56H28M12 47.16H28M12 48.76H28M12 50.36H28M12 51.96H28M12 53.56H28M12 55.16H28M12 56.76H28M12 58.36H28"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="12" y="44" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip14)">
      <path
        opacity="0.05"
        d="M29.44 44.2L29.44 60.2M31.04 44L31.04 60M32.64 44L32.64 60M34.24 44L34.24 60M35.84 44L35.84 60M37.44 44L37.44 60M39.04 44L39.04 60M40.64 44L40.64 60M42.24 44V60M28 45.56H44M28 47.16H44M28 48.76H44M28 50.36H44M28 51.96H44M28 53.56H44M28 55.16H44M28 56.76H44M28 58.36H44"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="28" y="44" width="16" height="16" stroke="#1F50BD" />
    <g clipPath="url(#decoration-clip15)">
      <path
        opacity="0.05"
        d="M45.44 44.2L45.44 60.2M47.04 44L47.04 60M48.64 44L48.64 60M50.24 44L50.24 60M51.84 44L51.84 60M53.44 44L53.44 60M55.04 44L55.04 60M56.64 44L56.64 60M58.24 44V60M44 45.56H60M44 47.16H60M44 48.76H60M44 50.36H60M44 51.96H60M44 53.56H60M44 55.16H60M44 56.76H60M44 58.36H60"
        stroke="white"
        strokeWidth="0.4"
      />
    </g>
    <rect x="44" y="44" width="16" height="16" stroke="#1F50BD" />
  </g>
);

export const Decoration: IconComponent = (props) => (
  <svg
    width="56"
    height="56"
    viewBox="0 0 56 56"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    {/* LIGHT MODE — full square grid (corners visible) with a radial
        white-gradient overlay that softly fades the cell strokes back
        into the white card surface near the edges. Mirrors the
        original `Decoration.svg` exactly. */}
    <g className="dark:hidden">
      <CellGrid />
      <rect width="56" height="56" fill="url(#decoration-fade)" />
    </g>

    {/* DARK MODE — same grid, but clipped by a Gaussian-blurred ellipse
        mask. The dark card surface shows through everywhere the mask
        hides; only the inner ~2×2 cells stay fully opaque. */}
    <g className="hidden dark:block" mask="url(#decoration-mask)">
      <CellGrid />
    </g>

    <defs>
      {/* Light mode overlay — transparent center → opaque white edges,
          painted over the strokes to fade them into the card surface. */}
      <radialGradient
        id="decoration-fade"
        cx="0"
        cy="0"
        r="1"
        gradientTransform="matrix(0 28 -28.1237 -3.12242 28 28)"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="white" stopOpacity="0" />
        <stop offset="1" stopColor="white" />
      </radialGradient>

      {/* Dark mode mask + Gaussian blur for the soft elliptical reveal.
          stdDeviation=2 keeps the inner cells crisp while feathering
          the outer ones to near-zero alpha. */}
      <mask
        id="decoration-mask"
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="56"
        height="55"
      >
        <g filter="url(#decoration-mask-blur)">
          <ellipse cx="28" cy="27.5" rx="24" ry="23.5" fill="#D9D9D9" />
        </g>
      </mask>
      <filter
        id="decoration-mask-blur"
        x="0"
        y="0"
        width="56"
        height="55"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="2" />
      </filter>

      {/* Per-cell clip paths constrain the 5%-opacity interior pattern
          so each cell's strokes don't bleed into the neighbours. */}
      <clipPath id="decoration-clip0">
        <rect x="-4" y="-4" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip1">
        <rect x="12" y="-4" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip2">
        <rect x="28" y="-4" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip3">
        <rect x="44" y="-4" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip4">
        <rect x="-4" y="12" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip5">
        <rect x="12" y="12" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip6">
        <rect x="28" y="12" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip7">
        <rect x="44" y="12" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip8">
        <rect x="-4" y="28" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip9">
        <rect x="12" y="28" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip10">
        <rect x="28" y="28" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip11">
        <rect x="44" y="28" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip12">
        <rect x="-4" y="44" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip13">
        <rect x="12" y="44" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip14">
        <rect x="28" y="44" width="16" height="16" fill="white" />
      </clipPath>
      <clipPath id="decoration-clip15">
        <rect x="44" y="44" width="16" height="16" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

export default Decoration;

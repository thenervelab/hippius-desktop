import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * What a card checkout will actually offer, shown as the brand marks people
 * recognise.
 *
 * "Card" on its own undersells the rail: Stripe's checkout also offers Link
 * and Apple Pay, and someone scanning for the way they normally pay will not
 * find it in a sentence. The marks answer that at a glance.
 *
 * Deliberately not an entry in `ui/icons`: those are single-colour glyphs
 * driven by `currentColor`, and a brand mark is neither. It lives here as a
 * composed strip so any other surface offering the same rail can reuse it
 * rather than growing a second copy.
 *
 * Kept in step with the console's copy of this component: the two dialogs
 * offer the same Stripe checkout, so they must not disagree about what it
 * accepts.
 */

/** One mark on its own plate, so the brand colours never sit on the row. */
const Plate: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <span
    role="img"
    aria-label={label}
    title={label}
    className="flex h-[20px] w-[30px] shrink-0 items-center justify-center rounded-[4px] border border-grey-dark-100 bg-white dark:border-black-300 dark:bg-grey-light-100"
  >
    {children}
  </span>
);

const Visa = () => (
  <svg viewBox="0 0 24 8" className="h-[8px] w-[21px]" aria-hidden>
    <text
      x="12"
      y="7"
      textAnchor="middle"
      fontSize="8"
      fontWeight="700"
      fontStyle="italic"
      fontFamily="Helvetica, Arial, sans-serif"
      fill="#1434CB"
    >
      VISA
    </text>
  </svg>
);

const Mastercard = () => (
  <svg viewBox="0 0 24 16" className="h-[13px] w-[21px]" aria-hidden>
    <circle cx="9.5" cy="8" r="5" fill="#EB001B" />
    <circle cx="14.5" cy="8" r="5" fill="#F79E1B" />
    {/* The overlap is its own colour on the real mark, not a blend. */}
    <path
      d="M12 4.05a5 5 0 0 0 0 7.9 5 5 0 0 0 0-7.9Z"
      fill="#FF5F00"
    />
  </svg>
);

const ApplePay = () => (
  <svg viewBox="0 0 24 10" className="h-[10px] w-[23px]" aria-hidden>
    <path
      d="M5.6 2.2c.2-.24.33-.56.29-.89-.28.01-.63.19-.84.43-.19.2-.35.53-.31.85.32.02.64-.16.86-.39Zm.28.45c-.47-.03-.86.26-1.08.26-.22 0-.56-.25-.92-.25-.48.01-.91.28-1.16.71-.49.86-.13 2.12.35 2.82.24.34.52.72.89.71.35-.01.49-.23.92-.23.43 0 .55.23.92.22.38-.01.62-.35.86-.69.27-.39.38-.77.38-.79-.01-.01-.73-.28-.74-1.12 0-.7.57-1.03.6-1.05-.33-.48-.84-.54-1.02-.55Z"
      fill="#000"
    />
    <text
      x="9"
      y="8"
      fontSize="7"
      fontWeight="600"
      fontFamily="Helvetica, Arial, sans-serif"
      fill="#000"
    >
      Pay
    </text>
  </svg>
);

const Link = () => (
  <svg viewBox="0 0 24 10" className="h-[10px] w-[23px]" aria-hidden>
    <rect width="24" height="10" rx="2" fill="#00D66F" />
    <text
      x="12"
      y="7.4"
      textAnchor="middle"
      fontSize="6"
      fontWeight="700"
      fontFamily="Helvetica, Arial, sans-serif"
      fill="#011E0F"
    >
      link
    </text>
  </svg>
);

/**
 * Apple Pay only appears at checkout on an Apple device in a browser that
 * offers it, so it is listed last: the two card networks and Link are what
 * every visitor will see.
 */
const PaymentBrandMarks: FC<{ className?: string }> = ({ className }) => (
  <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
    <Plate label="Visa">
      <Visa />
    </Plate>
    <Plate label="Mastercard">
      <Mastercard />
    </Plate>
    <Plate label="Link">
      <Link />
    </Plate>
    <Plate label="Apple Pay">
      <ApplePay />
    </Plate>
  </span>
);

export default PaymentBrandMarks;

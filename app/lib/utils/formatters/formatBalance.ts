/**
 * Formats blockchain balance values from planck (18 decimals) to human-readable format.
 * Uses string manipulation to avoid Number precision loss for large values.
 * @param balance - The balance string (in smallest unit / planck)
 * @param decimals - Number of decimal places to show (default: 6)
 * @returns Formatted balance string
 */
export function formatBalance(
  balance: string | number,
  decimals: number = 6
): string {
  try {
    const planckStr = balance.toString();

    // Handle zero case
    if (!planckStr || planckStr === '0') {
      return "0";
    }

    // Pad with leading zeros if needed (for values less than 1 token)
    const paddedStr = planckStr.padStart(19, '0'); // 18 decimals + at least 1 integer digit

    // Split into integer and fractional parts
    const splitIndex = paddedStr.length - 18;
    const integerPart = paddedStr.slice(0, splitIndex) || '0';
    const fractionalPart = paddedStr.slice(splitIndex);

    // Take specified number of decimals for display
    const formattedFractional = fractionalPart.substring(0, decimals);

    // Remove leading zeros from integer part
    const cleanIntegerPart = integerPart.replace(/^0+/, '') || '0';

    // Add thousand separators to integer part
    const withCommas = cleanIntegerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    // Trim trailing zeros from fractional part for cleaner display
    const trimmedFractional = formattedFractional.replace(/0+$/, '');

    // Return with or without decimal part
    if (trimmedFractional) {
      return `${withCommas}.${trimmedFractional}`;
    }
    return withCommas;
  } catch (error) {
    console.error("Error formatting balance:", error);
    return "0";
  }
}

/**
 * If the input is in scientific notation (e.g., "1.23e+5"),
 * return its full string value. Otherwise, return the input unchanged.
 */
export function sciToFullString(input: string): string {
  const s = input.trim();
  const sciRe = /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)[eE][+-]?\d+$/;
  if (!sciRe.test(s)) return input; // not scientific -> return as-is

  const sign = s.startsWith("-") ? "-" : "";
  const body = s.replace(/^[+-]/, "");
  const [coeff, expStr] = body.split(/[eE]/);
  const exp = parseInt(expStr, 10);

  const [intPart, fracPart = ""] = coeff.split(".");
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
  const fracLen = fracPart.length;

  if (exp >= 0) {
    // Move decimal to the right
    if (exp >= fracLen) {
      // becomes an integer
      const zeros = "0".repeat(exp - fracLen);
      const out = (digits + zeros).replace(/^0+(?=\d)/, "") || "0";
      return sign + out;
    } else {
      // stays decimal
      const pos = intPart.length + exp;
      const merged = intPart + fracPart;
      const before = merged.slice(0, pos).replace(/^0+(?=\d)/, "") || "0";
      const after = merged.slice(pos);
      return sign + before + "." + after;
    }
  } else {
    // Move decimal to the left
    const abs = Math.abs(exp);
    const merged = intPart + fracPart;
    if (abs >= intPart.length) {
      const zeros = "0".repeat(abs - intPart.length);
      const tail = merged.replace(/^0+/, "") || "0";
      return sign + "0." + zeros + tail;
    } else {
      const pos = intPart.length - abs;
      const before = intPart.slice(0, pos).replace(/^0+(?=\d)/, "") || "0";
      const after = intPart.slice(pos) + fracPart;
      return sign + before + "." + after;
    }
  }
}

/**
 * Formats blockchain balance values by dividing by 10^18 and formatting with commas
 * @param balance - The balance string (in smallest unit)
 * @param decimals - Number of decimal places to show (default: 5)
 * @returns Formatted balance string
 */
export function formatBalance(
  balance: string | number,
  decimals: number = 5
): string {
  try {
    // Convert to number and divide by 10^18
    const balanceNum = Number(balance) / Math.pow(10, 18);

    // If the result is 0, return "0"
    if (balanceNum === 0) {
      return "0";
    }

    // Format with specified decimal places and add commas
    const formatted = balanceNum.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });

    return formatted;
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

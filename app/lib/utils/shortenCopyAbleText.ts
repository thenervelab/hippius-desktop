type BreakpointFlags = {
  isMobile?: boolean;
  isLaptop?: boolean;
  isDesktop?: boolean;
  isLargeDesktop?: boolean;
};

type TruncationStyle = "end" | "middle";

export const shortenCopyAbleText = (
  address: string,
  breakpointsOrOptions?:
    | BreakpointFlags
    | { style?: TruncationStyle; startLen?: number; endLen?: number }
): string => {
  // Check if we're using the old breakpoints API or the new options API
  if (!breakpointsOrOptions) {
    return short(address, 5, 5);
  }

  // Handle the options-based API
  if ("style" in breakpointsOrOptions) {
    const { style = "end", startLen = 5, endLen = 5 } = breakpointsOrOptions;

    if (style === "middle") {
      return shortMiddle(address, startLen, endLen);
    }
    return short(address, startLen, endLen);
  }

  // Handle the legacy breakpoints API
  if (
    typeof breakpointsOrOptions === "object" &&
    ("isMobile" in breakpointsOrOptions ||
      "isLaptop" in breakpointsOrOptions ||
      "isDesktop" in breakpointsOrOptions ||
      "isLargeDesktop" in breakpointsOrOptions)
  ) {
    const { isMobile, isLaptop, isDesktop, isLargeDesktop } =
      breakpointsOrOptions as BreakpointFlags;

    if (Object.values(breakpointsOrOptions).every((flag) => !flag)) {
      return short(address, 5, 5);
    }

    if (isDesktop || isLargeDesktop || isLaptop) return address;
    if (isMobile) return short(address, 5, 5);

    return short(address, 5, 5);
  }

  // Default fallback to ensure a string is always returned
  return short(address, 5, 5);
};

function short(address: string, startLen: number, endLen: number) {
  if (!address || address.length <= startLen + endLen + 3) return address;
  return `${address.slice(0, startLen)}.....${address.slice(-endLen)}`;
}

// New function to truncate from the middle
function shortMiddle(address: string, startLen: number, endLen: number) {
  if (!address || address.length <= startLen + endLen + 3) return address;
  return `${address.slice(0, startLen)}...${address.slice(-endLen)}`;
}

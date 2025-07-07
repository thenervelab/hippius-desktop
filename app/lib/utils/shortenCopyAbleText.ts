type BreakpointFlags = {
  isMobile?: boolean;
  isLaptop?: boolean;
  isDesktop?: boolean;
  isLargeDesktop?: boolean;
  isTable?: boolean;
};

export const shortenCopyAbleText = (
  address: string,
  breakpoints?: BreakpointFlags
): string => {
  const {
    isMobile = false,
    isLaptop = false,
    isDesktop = false,
    isLargeDesktop = false,
    isTable = false,
  } = breakpoints || {};

  // 1) If it's a "table" layout...
  if (isTable) {
    //   – on mobile, keep 5…5
    if (isMobile) {
      return short(address, 5, 5);
    }
    //   – otherwise (tablet or larger), use 12…12
    return short(address, 12, 12);
  }

  // 2) No flags = default to 5…5
  if (
    !breakpoints ||
    [isMobile, isLaptop, isDesktop, isLargeDesktop].every((f) => !f)
  ) {
    return short(address, 5, 5);
  }

  // 3) For laptop/desktop, show the full address
  if (isLaptop || isDesktop || isLargeDesktop) {
    return address;
  }

  // 4) For any other mobile case, 5…5
  if (isMobile) {
    return short(address, 5, 5);
  }

  // 5) Fallback
  return short(address, 5, 5);
};

function short(address: string, startLen: number, endLen: number) {
  if (!address || address.length <= startLen + endLen + 3) return address;
  return `${address.slice(0, startLen)}…${address.slice(-endLen)}`;
}

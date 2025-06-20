export const toOrdinal = (n: number): string => {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
};

export function formatCredits(credits: number | bigint): string {
  const value = typeof credits === "bigint" ? Number(credits) : credits;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export const formatCreditBalance = (credits: bigint | null): string => {
  if (credits === null) return "---";

  // Divide by 10^18 as blockchain tokens typically have 18 decimal places
  const divisor = BigInt(10) ** BigInt(18);
  const integerPart = credits / divisor;
  const fractionalPart = credits % divisor;

  // Format with exactly 6 decimal places for consistency
  const fractionalStr = fractionalPart.toString().padStart(18, "0");
  const formattedFractional = fractionalStr.substring(0, 6);

  return `${integerPart}.${formattedFractional}`;
};

export function formatBalance(credits: number | bigint): string {
  const value = typeof credits === "bigint" ? Number(credits) : credits;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

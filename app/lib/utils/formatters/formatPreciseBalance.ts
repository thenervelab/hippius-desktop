export const formatPreciseBalance = (amount: number, precision: number = 6): string => {
    if (isNaN(amount) || amount === 0) {
        return "0.000000";
    }

    // For amounts less than 1, always show exactly 6 decimals for consistency
    if (amount < 1) {
        return amount.toFixed(6);
    }

    // For amounts between 1 and 1000, show 6 decimals for consistency
    if (amount < 1000) {
        return amount.toFixed(6);
    }

    // For very large amounts, use compact notation
    if (amount >= 1000000) {
        return (amount / 1000000).toFixed(2) + "M";
    }

    if (amount >= 1000) {
        return (amount / 1000).toFixed(2) + "K";
    }

    return amount.toFixed(precision);
};

/**
 * Format a planck value (string or BigInt) directly to decimal string with 6 decimals.
 * Uses string manipulation to avoid Number precision loss for large values.
 * @param planckValue - Raw planck value as string or BigInt (18 decimals)
 * @returns Formatted decimal string with 6 decimal places
 */
export const formatPlanckToDecimal = (planckValue: string | bigint): string => {
    if (!planckValue || planckValue === '0' || planckValue.toString() === '0') {
        return "0.000000";
    }

    // Convert to string if BigInt
    const planckStr = planckValue.toString();

    // Pad with leading zeros if needed (for values less than 1 token)
    const paddedStr = planckStr.padStart(19, '0'); // 18 decimals + at least 1 integer digit

    // Split into integer and fractional parts
    const splitIndex = paddedStr.length - 18;
    const integerPart = paddedStr.slice(0, splitIndex) || '0';
    const fractionalPart = paddedStr.slice(splitIndex);

    // Take first 6 decimals for display
    const formattedFractional = fractionalPart.substring(0, 6);

    // Remove leading zeros from integer part
    const cleanIntegerPart = integerPart.replace(/^0+/, '') || '0';

    return `${cleanIntegerPart}.${formattedFractional}`;
};
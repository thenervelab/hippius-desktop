export const formatPreciseBalance = (amount: number, precision: number = 8): string => {
    if (isNaN(amount) || amount === 0) {
        return "0.00";
    }

    // For very small amounts, show more precision
    if (amount < 0.01) {
        return amount.toFixed(precision);
    }

    // For normal amounts, show reasonable precision
    if (amount < 1) {
        return amount.toFixed(4);
    }

    // For larger amounts, show fewer decimals
    if (amount < 1000) {
        return amount.toFixed(2);
    }

    // For very large amounts, use compact notation
    if (amount >= 1000000) {
        return (amount / 1000000).toFixed(2) + "M";
    }

    if (amount >= 1000) {
        return (amount / 1000).toFixed(1) + "K";
    }

    return amount.toFixed(2);
};
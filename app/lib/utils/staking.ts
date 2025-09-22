import { formatBalance } from './formatters/formatBalance';

export const formatStakingAmount = (amount: string): string => {
    return formatBalance(amount);
};

// Convert amount from human-readable to planck (18 decimals)
export const toPlancks = (amount: string): string => {
    if (!amount || isNaN(Number(amount))) {
        throw new Error("Invalid amount");
    }

    // Support both integer and decimal input
    const [whole, fraction = ""] = amount.split(".");
    const fractionPadded = (fraction + "0".repeat(18)).slice(0, 18);
    let planckAmount = whole + fractionPadded;

    // Remove leading zeros
    planckAmount = planckAmount.replace(/^0+/, "");
    if (!planckAmount) planckAmount = "0";

    return planckAmount;
};

// Convert amount from planck to human-readable (18 decimals)
export const fromPlancks = (amount: string): number => {
    const planckValue = parseFloat(amount);
    return planckValue / 1e18;
};

export const getExplorerUrl = (address: string, type: 'account' | 'extrinsic' = 'account'): string => {
    // Replace with your actual explorer URL
    const baseUrl = 'https://hipstats.com';

    if (type === 'account') {
        return `${baseUrl}/account/${address}`;
    } else {
        return `${baseUrl}/extrinsic/${address}`;
    }
};

export const openInExplorer = (address: string, type: 'account' | 'extrinsic' = 'account'): void => {
    const url = getExplorerUrl(address, type);
    window.open(url, '_blank', 'noopener,noreferrer');
};
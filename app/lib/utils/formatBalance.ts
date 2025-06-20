/**
 * Formats blockchain balance values by dividing by 10^18 and formatting with commas
 * @param balance - The balance string (in smallest unit)
 * @param decimals - Number of decimal places to show (default: 5)
 * @returns Formatted balance string
 */
export function formatBalance(balance: string | number, decimals: number = 5): string {
  try {
    // Convert to number and divide by 10^18
    const balanceNum = Number(balance) / Math.pow(10, 18);
    
    // If the result is 0, return "0"
    if (balanceNum === 0) {
      return "0";
    }
    
    // Format with specified decimal places and add commas
    const formatted = balanceNum.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
    
    return formatted;
  } catch (error) {
    console.error('Error formatting balance:', error);
    return '0';
  }
}

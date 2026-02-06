/**
 * Hook to get the active wallet address from LocalWallet or WalletAuth context
 * Provides a unified address source for all wallet-related operations
 */
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export function useActiveWalletAddress(): string | null {
    const { activeWallet } = useLocalWallet();
    const { polkadotAddress } = useWalletAuth();

    // Priority: Local wallet address (if available) > WalletAuth address
    // This ensures that when user has local wallets, we use the active local wallet's address
    if (activeWallet?.address) {
        return activeWallet.address;
    }

    // Fallback to WalletAuth address (for OAuth or legacy mnemonic login)
    return polkadotAddress;
}

export default useActiveWalletAddress;

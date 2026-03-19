/**
 * All files are now private by default — no public/private distinction.
 * This hook is kept for backward compatibility but always returns `true`.
 */
export const useIsPrivateView = (): boolean => {
  return true;
};

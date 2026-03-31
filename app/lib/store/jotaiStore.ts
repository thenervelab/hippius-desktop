import { createStore } from "jotai";

/**
 * Shared Jotai store used by both the React <Provider> tree
 * and non-React code (e.g., wallet-auth-context).
 *
 * This ensures atoms written via `appStore.set()` outside React
 * are visible to `useAtom()` inside the Provider.
 */
export const appStore = createStore();

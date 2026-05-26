import { atom } from "jotai";

/**
 * Refcount of in-flight bridge submissions. The bridge dialog
 * increments at the start of a submit (after the password
 * confirmation) and decrements once the submit settles — success,
 * error, or cancel.
 *
 * Why a refcount and not a boolean: in principle a user could
 * stack two submits (e.g. minimise the toast on submit A, then
 * submit B). A boolean would race on the second submit's cleanup
 * and leave the gate stuck open or stuck closed. The counter is
 * trivially correct.
 *
 * Consumers:
 *  - `LocalWalletContext` reads this to skip the 5-min idle
 *    auto-lock while a bridge is mid-flight. Without the skip, a
 *    long submit (slow testnet block production) would silently
 *    flip the soft-locked UX state while the user is watching
 *    progress, leaving them on a "wallet locked" page that's
 *    actively signing. The closure-scoped password keeps signing
 *    regardless, so this is a UX issue, not a correctness one —
 *    but it's confusing.
 *
 *  - Future: a tray indicator, a navigation guard ("a bridge is
 *    in progress, are you sure?"), etc.
 */
export const bridgeInFlightAtom = atom(0);

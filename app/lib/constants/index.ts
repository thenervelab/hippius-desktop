export * from "./urls";
export const API_BASE_URL = "https://indexer.hippius.network";

/**
 * Polling cadence for live on-chain / indexer-backed queries (ms).
 *
 * The Hippius parachain produces a block every ~6 s and node stats are
 * pushed every block, so the freshest a client can ever be is one block
 * old. Polling faster only burns duplicate round-trips for the same
 * snapshot; polling slower (the old per-hook 30 s) means the home page,
 * wallet, and shares views lag the chain by up to five blocks.
 *
 * Every live query reads this one constant so they cannot drift onto
 * different poll phases — the cache-key-sharing hooks (shares page +
 * `useSharedFiles`) in particular relied on two hand-kept copies of the
 * interval staying equal; one source removes that footgun. Static config
 * data (VM flavors/images, SSH keys, referrals) deliberately does NOT
 * use this — it changes on the order of hours, not blocks.
 */
export const LIVE_DATA_REFRESH_MS = 6_000;

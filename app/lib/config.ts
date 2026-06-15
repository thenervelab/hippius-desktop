export const REFERRAL_CODE_CONFIG = {
  link: "https://console.hippius.com/login?referral_code=",
} as const;

/**
 * Hippius public API base URL. Only the bits the referrals page needs
 * right now are added — additional endpoints can land here as the
 * desktop hits them. Mirrors `API_CONFIG.baseUrl` in hippius-web so a
 * `${API_CONFIG.baseUrl}/api/referrals/generate` POST resolves to the
 * same endpoint.
 */
export const API_CONFIG = {
  baseUrl: "https://api.hippius.com",
} as const;

export const HCFS_CONFIG = {
  // Empty string is the auto-detect sentinel that the Rust backend forwards
  // to hcfs-client; the client races the regional `*-arion.hippius.com`
  // endpoints (EU and US) and picks the faster one. Setting an explicit
  // URL here would skip the probe — keep this empty unless you intentionally
  // want to pin every desktop install to a single region.
  defaultServerUrl: "",
  apiKey: "Arion",
} as const;

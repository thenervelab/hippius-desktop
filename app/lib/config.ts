export const REFERRAL_CODE_CONFIG = {
  link: "https://console.hippius.com/login?referral_code=",
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

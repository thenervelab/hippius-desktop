export const API_CONFIG = {
  IPFS_GATEWAY:
    process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://relay-fr.hippius.network",
  auth: {
    mnemonic: "/api/auth/mnemonic/",
    verify: "/api/auth/verify/",
    csrf: "/api/csrf/",
    userProfile: "/api/user-profile/",
  },
  sshKeys: {
    list: "/api/ssh-keys/",
    create: "/api/ssh-keys/",
    get: (id: string) => `/api/ssh-keys/${id}/`,
    delete: (id: string) => `/api/ssh-keys/${id}/`,
  },
} as const;

export const AUTH_CONFIG = {
  tokenStorageKey: "hippius_session_token",
  tokenExpiryKey: "hippius_token_expiry",
} as const;

export const IPFS_NODE_CONFIG = {
  baseURL: "http://127.0.0.1:5001",
} as const;

export const HIPPIUS_EXPLORER_CONFIG = {
  baseUrl: "https://hipstats.com",
} as const;

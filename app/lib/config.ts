export const API_CONFIG = {
  baseUrl: "https://api.hippius.com",
  IPFS_GATEWAY: "https://relay-fr.hippius.network",
  auth: {
    mnemonic: "/api/auth/mnemonic/",
    verify: "/api/auth/verify/",
    csrf: "/api/csrf/",
    userProfile: "/api/user-profile/",
    // OAuth endpoints
    oauth: {
      google: "/accounts/google/login/",
      github: "/accounts/github/login/",
      apple: "/accounts/apple/login/",
      exchange: "/auth/exchange/",
    },
  },
  sshKeys: {
    list: "/api/ssh-keys/",
    create: "/api/ssh-keys/",
    get: (id: string) => `/api/ssh-keys/${id}/`,
    delete: (id: string) => `/api/ssh-keys/${id}/`,
  },
  billing: {
    credits: "/api/billing/credits/balance/",
    transactions: "/api/billing/transactions/",
    transactionDetail: (id: string) => `/api/billing/transactions/${id}`,
    customerPortal: "/api/billing/stripe/customer-portal/",
    activeSubscription: "/api/billing/stripe/active-subscription/",
    subscriptionPlans: "/api/billing/stripe/subscription-plans/",
    createSubscription: "/api/billing/stripe/create-subscription/",
  },
  infrastructure: {
    tokens: {
      list: "/api/infrastructure/tokens/service/list/",
      create: "/api/infrastructure/tokens/service/",
      revoke: (id: string) =>
        `/api/infrastructure/tokens/service/${id}/revoke/`,
    },
    vm: {
      flavors: "/api/infrastructure/vm/flavors/",
      images: "/api/infrastructure/vm/images/",
      applications: "/api/infrastructure/vm/applications/",
      spawn: "/api/infrastructure/vm/spawn/",
      instances: "/api/infrastructure/vm/instances/",
      instance: (id: number) => `/api/infrastructure/vm/instances/${id}/`,
      reboot: (id: number) => `/api/infrastructure/vm/instances/${id}/reboot/`,
      start: (id: number) => `/api/infrastructure/vm/instances/${id}/start/`,
      stop: (id: number) => `/api/infrastructure/vm/instances/${id}/stop/`,
      terminate: (id: number) =>
        `/api/infrastructure/vm/instances/${id}/terminate/`,
    },
  },
} as const;

export const AUTH_CONFIG = {
  tokenStorageKey: "hippius_session_token",
  tokenExpiryKey: "hippius_token_expiry",
} as const;

export const REFERRAL_CODE_CONFIG = {
  link: "https://console.hippius.com/login?referral_code=",
} as const;

export const IPFS_NODE_CONFIG = {
  baseURL: "http://127.0.0.1:5001",
} as const;

export const STORAGE_S3_CONFIG = {
  AWS_REGION: "decentralized",
  S3_ENDPOINT: "https://s3.hippius.com",
  HMAC_SECRET: "X5Ppyz3aMHw3PVFitlA587TiingYrB3R",
  endpoints: {
    masterToken: {
      check: "/api/s3/master-token/check/",
      create: "/api/s3/master-token/create/",
    },
    buckets: {
      list: "/api/s3/buckets/",
      create: "/api/s3/buckets/create/",
      delete: (name: string) => `/api/s3/buckets/${name}/delete/`,
    },
    objects: {
      list: (bucket: string) => `/api/s3/buckets/${bucket}/objects/`,
      create: (bucket: string) => `/api/s3/buckets/${bucket}/objects/create/`,
      delete: (bucket: string, key: string) =>
        `/api/s3/buckets/${bucket}/objects/${key}/delete/`,
    },
  },
} as const;

export const HIPPIUS_EXPLORER_CONFIG = {
  baseUrl: "https://hipstats.com",
} as const;

export const STORAGE_CONTROL_CONFIG = {
  baseUrl: `${API_CONFIG.baseUrl}/api/storage-control`,
  endpoints: {
    upload: "/api/storage-control/upload/",
    requests: "/api/storage-control/requests/",
    uploads: "/api/storage-control/uploads/",
    files: "/api/storage-control/files",
    profileSummary: "/api/storage-control/profile-summary/",
  },
} as const;

export const SUPPORT_CONFIG = {
  baseUrl: `${API_CONFIG.baseUrl}/api/support`,
  endpoints: {
    list: "/tickets/",
  },
} as const;

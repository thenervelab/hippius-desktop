# Migration Plan: Move Business Logic from Frontend to Rust

> Created: 2026-03-11
> Branch: sync-engine
> Estimated scope: ~5,700 lines of JS/TS logic to replace with Rust Tauri commands

This plan is organized into 7 phases, ordered by security impact and dependency chain. Each phase can be developed, tested, and shipped independently.

---

## Phase 1: Secure Credential Storage & Session Management

**Goal:** Eliminate IndexedDB/localStorage for sensitive data. Consolidate all credential storage into the Rust SQLite database. Remove the frontend sql.js dependency entirely.

**Why first:** Every subsequent phase depends on having a secure, Rust-managed session and token store.

### 1.1 New Database Tables

Add to `src-tauri/src/builder_blocks/setup/mod.rs`:

```sql
-- Replace frontend IndexedDB "wallet" table
CREATE TABLE IF NOT EXISTS wallet_store (
    owner TEXT PRIMARY KEY,
    encrypted_mnemonic TEXT NOT NULL,
    passcode_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Replace frontend IndexedDB "session" table + localStorage tokens
CREATE TABLE IF NOT EXISTS auth_session (
    owner TEXT PRIMARY KEY,
    auth_token TEXT,
    token_expiry INTEGER,          -- epoch ms
    user_id INTEGER,
    username TEXT,
    provider TEXT,                  -- "mnemonic" | "google" | "github" | "apple"
    substrate_address TEXT,
    logout_time_minutes INTEGER DEFAULT 1440,
    last_login_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 1.2 New Rust Commands

**File:** `src-tauri/src/commands/session.rs` (new)

| Command | Replaces | Description |
|---------|----------|-------------|
| `save_wallet` | `hippiusDesktopDB.saveWallet()` | Store AES-encrypted mnemonic + passcode hash |
| `get_wallet` | `hippiusDesktopDB.getWalletRecord()` | Retrieve encrypted wallet record |
| `has_wallet` | `hippiusDesktopDB.hasPasscode()` | Check if wallet/passcode exists |
| `clear_wallet` | `hippiusDesktopDB.clearWallet()` | Remove wallet record |
| `save_auth_session` | `sessionStore.saveSession()` + localStorage writes | Persist auth session (token, expiry, provider, etc.) |
| `get_auth_session` | `sessionStore.getSession()` + localStorage reads | Retrieve current session |
| `get_auth_token` | `sessionStore.getApiAuth()` | Get token + validate expiry server-side |
| `clear_auth_session` | `sessionStore.clearSession()` + localStorage removes | Wipe session on logout |
| `is_token_valid` | `isTokenValid()` in wallet-auth-context.tsx | Server-side token expiry check |

### 1.3 Frontend Changes

- **Remove:** `app/lib/helpers/hippiusDesktopDB.ts` (entire file — ~200 lines)
- **Remove:** `app/lib/helpers/sessionStore.ts` (entire file — ~269 lines)
- **Remove:** `app/lib/global-atoms/dbAtoms.ts` (sql.js atoms)
- **Remove:** `sql.js` dependency from `package.json`
- **Update:** `wallet-auth-context.tsx` — replace all `getSession()`, `saveSession()`, `getApiAuth()`, `saveApiAuth()`, `clearSession()`, `clearApiAuth()`, `getWalletRecord()`, `saveWallet()` calls with `invoke()` to the new Rust commands
- **Remove:** All `localStorage.getItem/setItem/removeItem` calls for `hippius_oauth_session`, `hippius_oauth_session_expiry`, `hippius_token`, `hippius_token_expiry`

### 1.4 Testing

- Rust unit tests: CRUD operations on `wallet_store` and `auth_session` tables
- Integration test: login → save session → restart app → restore session → verify token
- Verify: `localStorage` and `IndexedDB` contain zero auth-related data after migration

---

## Phase 2: Authentication & Cryptographic Operations

**Goal:** Move all key derivation, signing, challenge-response auth, and passcode encryption to Rust. The frontend never touches mnemonic material.

**Depends on:** Phase 1 (session storage in Rust)

### 2.1 New Rust Commands

**File:** `src-tauri/src/commands/auth.rs` (new)

| Command | Replaces | Description |
|---------|----------|-------------|
| `login_with_mnemonic` | `login()` in wallet-auth-context.tsx + `authService.requestChallenge/verifySignature` | Full challenge-response flow: validate mnemonic → derive keypairs → request challenge → sign → verify → store session → return result |
| `login_with_oauth_token` | `setOAuthSession()` in wallet-auth-context.tsx | Validate token → store session → generate sync mnemonic if needed → return session info |
| `unlock_with_passcode` | `unlockWithPasscode()` in wallet-auth-context.tsx | Verify passcode hash → decrypt mnemonic → re-derive keypair → validate → return session |
| `set_passcode` | Passcode setup flow | Hash passcode → AES-encrypt mnemonic → store in `wallet_store` |
| `validate_mnemonic` | `isMnemonicValid()` | Validate BIP-39 mnemonic format (return bool) |
| `get_session_info` | Session restore on boot | Check `auth_session` table → validate token expiry → return session data or "expired" |
| `refresh_auth_token` | Silent token refresh in wallet-auth-context.tsx | Fetch mnemonic from Drive → derive keypairs → challenge-response → update token |
| `logout` | `logout()` in wallet-auth-context.tsx | Stop sync → clear session → clear in-memory keypair |
| `get_polkadot_address` | Deriving address in frontend | Return the SS58 address for the current session (derived from stored keypair) |

### 2.2 In-Memory Key Management (Rust-side)

Add a global keypair holder:

```rust
// src-tauri/src/auth_state.rs (new)
use sp_core::sr25519;
use std::sync::Mutex;
use once_cell::sync::Lazy;

pub struct AuthState {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
}

pub static AUTH_STATE: Lazy<Mutex<AuthState>> = Lazy::new(|| {
    Mutex::new(AuthState {
        sr25519_pair: None,
        substrate_address: None,
        eth_address: None,
    })
});
```

- `login_with_mnemonic` populates `AUTH_STATE` with derived keypairs
- `logout` clears `AUTH_STATE` and zeroizes keys
- Staking/transfer commands read from `AUTH_STATE` for signing
- Mnemonic is **never stored in memory** — only the derived keypair

### 2.3 `login_with_mnemonic` Implementation Sketch

Pattern follows existing `billing_auth.rs`:

```rust
#[tauri::command]
pub async fn login_with_mnemonic(
    app: tauri::AppHandle,
    mnemonic: String,
    referral_code: Option<String>,
    logout_time_minutes: Option<i64>,
) -> Result<LoginResult, String> {
    // 1. Validate mnemonic
    let parsed = bip39::Mnemonic::parse_in_normalized(Language::English, &mnemonic)
        .map_err(|e| format!("Invalid mnemonic: {}", e))?;

    // 2. Derive sr25519 (Substrate) keypair
    let (sr25519_pair, _) = sr25519::Pair::from_phrase(&mnemonic, None)
        .map_err(|e| format!("Key derivation failed: {}", e))?;
    let substrate_addr = sr25519_pair.public().to_ss58check();

    // 3. Derive secp256k1 (Ethereum) keypair
    let eth_signer: PrivateKeySigner = MnemonicBuilder::<English>::default()
        .phrase(&mnemonic)
        .build()
        .map_err(|e| format!("Eth derivation failed: {}", e))?;
    let eth_addr = format!("{}", eth_signer.address());

    // 4. Request challenge from API
    let client = reqwest::Client::new();
    let challenge_resp = client
        .post(format!("{}/api/auth/mnemonic/", API_BASE_URL))
        .json(&json!({
            "ethereum_address": eth_addr,
            "substrate_address": substrate_addr,
        }))
        .send().await.map_err(|e| e.to_string())?;
    let challenge_data: ChallengeResponse = challenge_resp.json().await.map_err(|e| e.to_string())?;

    // 5. Sign challenge with Ethereum key
    let signature = eth_signer
        .sign_message_sync(challenge_data.message.as_bytes())
        .map_err(|e| format!("Signing failed: {}", e))?;

    // 6. Verify with backend
    let verify_resp = client
        .post(format!("{}/api/auth/verify/", API_BASE_URL))
        .json(&json!({
            "signature": format!("0x{}", hex::encode(signature.as_bytes())),
            "address": eth_addr,
            "substrate_address": substrate_addr,
            "referral_code": referral_code,
        }))
        .send().await.map_err(|e| e.to_string())?;
    let auth_result: AuthResponse = verify_resp.json().await.map_err(|e| e.to_string())?;

    // 7. Store keypair in AUTH_STATE
    {
        let mut state = AUTH_STATE.lock().unwrap();
        state.sr25519_pair = Some(sr25519_pair);
        state.substrate_address = Some(substrate_addr.clone());
        state.eth_address = Some(eth_addr.clone());
    }

    // 8. Store session in DB
    save_auth_session(&substrate_addr, &auth_result.token, ...).await?;

    // 9. Persist auth token for sync engine
    save_temp_auth_key(&substrate_addr, &auth_result.token).await?;

    // 10. Zeroize mnemonic (the variable goes out of scope, but explicit is better)
    // Note: mnemonic String is on heap, will be dropped here

    Ok(LoginResult {
        substrate_address: substrate_addr,
        user_id: auth_result.user_id,
        username: auth_result.username,
        is_new: auth_result.is_new,
        provider: "mnemonic".to_string(),
    })
}
```

### 2.4 Frontend Changes

- **Rewrite:** `wallet-auth-context.tsx` — replace ~600 lines of crypto/auth logic with thin `invoke()` calls
- **Remove:** `app/lib/services/authService.ts` (entire file — ~315 lines)
- **Remove:** `app/lib/helpers/crypto.ts` (entire file — ~18 lines)
- **Remove:** `app/lib/helpers/validateMnemonic.ts` (entire file — ~5 lines)
- **Remove:** `@polkadot/keyring`, `@polkadot/util-crypto`, `viem`, `crypto-js` from frontend dependencies
- **Simplify:** `wallet-auth-context.tsx` becomes ~150 lines: call `invoke("login_with_mnemonic")`, store result in React state, render UI

### 2.5 Token Refresh

Replace the frontend `hcfs_auth_token_expired` listener with a Rust-side handler:

- When sync engine detects 401, call `refresh_auth_token` internally (no frontend round-trip)
- Emit `auth_token_refreshed` or `auth_token_refresh_failed` event to frontend for UI updates
- Fallback: if refresh fails, emit `auth_session_expired` event → frontend shows re-login dialog

### 2.6 Testing

- Rust unit tests: mnemonic validation, keypair derivation, challenge-response mock
- Integration test: full login flow with test server
- Test: passcode set → lock → unlock → verify keypair restored
- Test: token refresh on 401 (mock HCFS server)
- Verify: no `@polkadot/keyring` or `viem` imports remain in frontend

---

## Phase 3: Blockchain Operations (Staking, Transfers, Queries)

**Goal:** Move all Polkadot RPC queries and transaction signing to Rust. Remove polkadot.js from the frontend.

**Depends on:** Phase 2 (keypair stored in Rust `AUTH_STATE`)

### 3.1 New Rust Commands — Queries

**File:** `src-tauri/src/commands/blockchain.rs` (new)

| Command | Replaces | Description |
|---------|----------|-------------|
| `get_account_balance` | `useHippiusBalance` hook | Query `system.account(address)` → return `{free, reserved, frozen}` |
| `get_staking_info` | `useStaking` hook (query portion) | Query bonded/ledger/era/validators → return structured staking state |
| `get_referral_codes` | `useReferralLinks` hook | Query `credits.referralCodes.entries()` + rewards |
| `get_block_number` | `subscribeNewHeads` in polkadot-api-context | Subscribe in Rust, emit `block_number_updated` events |
| `get_system_balance_history` | `useSystemBalance` hook | Indexer API query, return balance history |

### 3.2 New Rust Commands — Transactions

| Command | Replaces | Description |
|---------|----------|-------------|
| `stake_bond` | `useStaking.bond()` | Sign & submit `staking.bond(amount, 'Staked')` or `staking.bondExtra(amount)` |
| `stake_unbond` | `useStaking.unbond()` | Sign & submit `staking.unbond(amount)` |
| `stake_withdraw` | `useStaking.withdrawUnbonded()` | Query slashing spans → sign & submit `staking.withdrawUnbonded(spans)` |
| `stake_claim_rewards` | `useStaking.claimRewards()` | Query current era → sign & submit `staking.payoutStakers(addr, era-1)` |
| `stake_nominate` | `useStaking.nominate()` | Sign & submit `staking.nominate(validators)` |

All transaction commands:
- Read keypair from `AUTH_STATE`
- Use existing `get_substrate_client()` singleton
- Wait for finalization
- Return `{tx_hash, block_hash, success, error?}`
- Emit progress events: `tx_submitted`, `tx_in_block`, `tx_finalized`

### 3.3 Block Subscription as Rust Background Task

Instead of a WebSocket from the frontend:

```rust
// Start on login, stop on logout
pub async fn start_block_subscription(app: tauri::AppHandle) {
    let client = get_substrate_client().await?;
    let mut blocks = client.blocks().subscribe_finalized().await?;
    while let Some(block) = blocks.next().await {
        let block = block?;
        let _ = app.emit("block_number_updated", block.number());
    }
}
```

Frontend listens to `block_number_updated` events — no WebSocket management needed.

### 3.4 Frontend Changes

- **Remove:** `app/lib/polkadot-api-context/` (entire directory)
- **Remove:** `app/lib/hooks/useStaking.ts` (~399 lines)
- **Remove:** `app/lib/hooks/api/useHippiusBalance.ts` (~63 lines)
- **Remove:** `app/lib/hooks/api/useReferralLinks.ts`
- **Remove:** `app/lib/hooks/api/useUserReferrals.ts`
- **Remove:** `app/lib/utils/blockTimestampUtils.ts`
- **Remove:** `@polkadot/api`, `@polkadot/types`, `@polkadot/rpc-provider` from package.json
- **Update:** All components using `usePolkadotApi()` context → replace with Tauri `invoke()` calls + event listeners
- **Update:** Staking UI → call `invoke("stake_bond", { amount })` instead of constructing transactions

### 3.5 Testing

- Rust integration tests: query balance on testnet
- Rust integration tests: submit staking transaction on testnet (or mock)
- Test: block subscription emits events correctly
- Test: transaction error handling (insufficient balance, etc.)
- Verify: zero `@polkadot/api` imports in frontend

---

## Phase 4: HTTP API Proxy Layer

**Goal:** Route all frontend HTTP API calls through Rust. The frontend never makes direct `fetch()` calls to external APIs. Rust manages auth headers, error handling, and retries.

**Depends on:** Phase 1 (token stored in Rust)

### 4.1 Architecture: Typed API Client in Rust

**File:** `src-tauri/src/api_client.rs` (new)

Create a reusable HTTP client that:
- Reads auth token from `auth_session` table
- Adds `Authorization: Token <token>` header automatically
- Handles 401 → trigger token refresh → retry once
- Handles common error codes (402, 403, 409) with structured error types
- Returns typed Rust structs (serde deserialized)

```rust
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
}

impl ApiClient {
    pub async fn get<T: DeserializeOwned>(&self, path: &str, account_id: &str) -> Result<T, ApiError> {
        let token = get_auth_token(account_id).await?;
        let resp = self.client
            .get(format!("{}{}", self.base_url, path))
            .header(AUTHORIZATION, format!("Token {}", token))
            .send()
            .await?;
        self.handle_response(resp).await
    }

    pub async fn post<T: DeserializeOwned, B: Serialize>(&self, path: &str, body: &B, account_id: &str) -> Result<T, ApiError> {
        // Similar with .json(body)
    }
}
```

### 4.2 Indexer Client in Rust

**File:** `src-tauri/src/indexer_client.rs` (new)

Replaces `app/lib/api/indexerClient.ts`:

```rust
pub struct IndexerClient {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl IndexerClient {
    pub async fn get<T: DeserializeOwned>(&self, path: &str, params: &[(&str, &str)]) -> Result<T, ApiError> {
        let url = reqwest::Url::parse_with_params(
            &format!("{}{}", self.base_url, path),
            params,
        )?;
        let resp = self.client
            .get(url)
            .header("X-API-KEY", &self.api_key)
            .header(ACCEPT, "application/json")
            .send()
            .await?;
        self.handle_response(resp).await
    }
}
```

### 4.3 New Rust Commands — VM Management

**File:** `src-tauri/src/commands/vm.rs` (new)

| Command | Replaces | Endpoint |
|---------|----------|----------|
| `list_vm_flavors` | `useVMFlavors` | `GET /api/infrastructure/vm/flavors/` |
| `list_vm_images` | `useVMImages` | `GET /api/infrastructure/vm/images/` |
| `list_vm_applications` | `useVMApplications` | `GET /api/infrastructure/vm/applications/` |
| `list_vm_instances` | `useVMInstances` | `GET /api/infrastructure/vm/instances/` |
| `get_vm_instance` | `useVMInstanceDetails` | `GET /api/infrastructure/vm/instances/{id}/` |
| `create_vm` | `useCreateVM` | `POST /api/infrastructure/vm/spawn/` |
| `start_vm` | `useStartVM` | `POST /api/infrastructure/vm/instances/{id}/start/` |
| `stop_vm` | `useStopVM` | `POST /api/infrastructure/vm/instances/{id}/stop/` |
| `reboot_vm` | `useRebootVM` | `POST /api/infrastructure/vm/instances/{id}/reboot/` |
| `terminate_vm` | `useTerminateVM` | `POST /api/infrastructure/vm/instances/{id}/terminate/` |

### 4.4 New Rust Commands — SSH Keys

**File:** `src-tauri/src/commands/ssh_keys.rs` (new)

| Command | Replaces | Endpoint |
|---------|----------|----------|
| `list_ssh_keys` | `useSSHKeys` | `GET /api/ssh-keys/` (paginated) |
| `create_ssh_key` | `useCreateSSHKey` | `POST /api/ssh-keys/` |
| `delete_ssh_key` | `useDeleteSSHKey` | `DELETE /api/ssh-keys/{id}/` |

### 4.5 New Rust Commands — Billing

**File:** `src-tauri/src/commands/billing.rs` (new)

| Command | Replaces | Endpoint |
|---------|----------|----------|
| `get_credits_balance` | `useCredits` | Indexer: `GET /credits/free-credits` |
| `get_billing_transactions` | `useBillingTransactions` | `GET /api/billing/transactions/` |
| `get_marketplace_credits` | `useMarketplaceCredits` | Indexer: `GET /marketplace/credit` |
| `get_subscription_plans` | Stripe hooks | `GET /api/billing/stripe/subscription-plans/` |
| `get_active_subscription` | Stripe hooks | `GET /api/billing/stripe/active-subscription/` |
| `create_subscription` | Stripe hooks | `POST /api/billing/stripe/create-subscription/` |
| `get_customer_portal_url` | Stripe hooks | `GET /api/billing/stripe/customer-portal/` |

### 4.6 New Rust Commands — Notifications & Profile

**File:** `src-tauri/src/commands/notifications.rs` (new)

| Command | Replaces | Endpoint |
|---------|----------|----------|
| `get_notification_settings` | `useNotificationSettings` | `GET /api/notifications/settings/` |
| `update_notification_settings` | `useNotificationSettings` mutation | `PATCH /api/notifications/settings/` |

### 4.7 New Rust Commands — S3/Object Store

**File:** `src-tauri/src/commands/object_store.rs` (new)

| Command | Replaces | Endpoint |
|---------|----------|----------|
| `list_s3_buckets` | `useApiBuckets` | `GET /api/s3/buckets/` |
| `create_s3_bucket` | S3 bucket creation | `POST /api/s3/buckets/create/` |
| `delete_s3_bucket` | S3 bucket deletion | `DELETE /api/s3/buckets/{name}/delete/` |
| `list_s3_objects` | S3 object listing | `GET /api/s3/buckets/{bucket}/objects/` |

### 4.8 Frontend Changes

- **Remove:** All 30+ files in `app/lib/hooks/api/` that make direct `fetch()` calls
- **Remove:** `app/lib/api/indexerClient.ts`
- **Remove:** `HMAC_SECRET` from `app/lib/config.ts`
- **Simplify:** `app/lib/config.ts` — remove all API endpoint URLs (they live in Rust now)
- **Replace:** Each removed hook with a thin wrapper around `invoke()`:

```typescript
// Before (useVMInstances.ts - 80 lines)
export function useVMInstances() {
  const { oauthSession } = useWalletAuth();
  return useQuery({
    queryKey: ["vm-instances"],
    queryFn: async () => {
      const response = await fetch(url, {
        headers: { Authorization: `Token ${oauthSession.token}` },
      });
      // ... error handling, parsing ...
    },
    staleTime: 30_000,
  });
}

// After (10 lines)
export function useVMInstances() {
  const { substrateAddress } = useWalletAuth();
  return useQuery({
    queryKey: ["vm-instances"],
    queryFn: () => invoke("list_vm_instances", { accountId: substrateAddress }),
    staleTime: 30_000,
  });
}
```

### 4.9 Testing

- Rust integration tests per API endpoint (mock HTTP server or test environment)
- Test: 401 retry → token refresh → retry original request
- Test: structured error responses (402, 403, 409)
- Verify: zero `fetch()` calls to external APIs remain in frontend (only `invoke()`)

---

## Phase 5: OAuth Flow Migration

**Goal:** Move PKCE generation, token exchange, and OAuth callback handling to Rust.

**Depends on:** Phase 1 (session storage), Phase 4 (API client)

### 5.1 New Rust Commands

**File:** `src-tauri/src/commands/oauth.rs` (new)

| Command | Replaces | Description |
|---------|----------|-------------|
| `start_oauth_flow` | `initiateOAuthLogin()` in oAuthService.ts | Generate PKCE verifier/challenge (CSPRNG), store in memory, return auth URL |
| `complete_oauth_flow` | `handleOAuthCallback()` in oAuthService.ts | Exchange code for token using stored PKCE verifier, store session, return result |
| `get_oauth_redirect_url` | URL construction in oAuthService.ts | Build provider-specific OAuth URL with PKCE params |

### 5.2 Implementation

```rust
use rand::RngCore;
use sha2::{Sha256, Digest};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

static PKCE_STATE: Lazy<Mutex<Option<PkceState>>> = Lazy::new(|| Mutex::new(None));

struct PkceState {
    code_verifier: String,
    provider: String,
}

#[tauri::command]
pub async fn start_oauth_flow(provider: String) -> Result<String, String> {
    // 1. Generate cryptographically secure code verifier
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(bytes);

    // 2. Generate code challenge
    let challenge = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(challenge);

    // 3. Store PKCE state
    *PKCE_STATE.lock().unwrap() = Some(PkceState {
        code_verifier: code_verifier.clone(),
        provider: provider.clone(),
    });

    // 4. Build auth URL
    let auth_url = build_oauth_url(&provider, &code_challenge)?;
    Ok(auth_url)
}

#[tauri::command]
pub async fn complete_oauth_flow(code: String) -> Result<LoginResult, String> {
    let pkce_state = PKCE_STATE.lock().unwrap().take()
        .ok_or("No pending OAuth flow")?;

    // Exchange code for token (server-to-server, not browser)
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/auth/exchange/", API_BASE_URL))
        .json(&json!({
            "code": code,
            "code_verifier": pkce_state.code_verifier,
        }))
        .send().await.map_err(|e| e.to_string())?;

    let auth_data: OAuthTokenResponse = resp.json().await.map_err(|e| e.to_string())?;

    // Store session
    save_auth_session(...).await?;
    save_temp_auth_key(...).await?;

    Ok(LoginResult { ... })
}
```

### 5.3 Deep Link Handling

The app uses `hippiusapp://` deep links for OAuth callbacks. Configure Tauri to route the callback to Rust:

- On OAuth callback (`hippiusapp://auth/callback?code=...`), extract the code in Rust
- Call `complete_oauth_flow(code)` internally
- Emit `oauth_completed` event to frontend with session data

### 5.4 Frontend Changes

- **Remove:** `app/lib/services/oAuthService.ts` (entire file — ~406 lines)
- **Update:** OAuth buttons → call `invoke("start_oauth_flow", { provider: "google" })` → get URL → open in browser
- **Update:** Callback handler → listen for `oauth_completed` event from Rust

### 5.5 Testing

- Test: PKCE verifier is cryptographically random (not `Math.random()`)
- Test: full OAuth flow with mock provider
- Test: deep link callback handling
- Verify: no `sessionStorage` usage for OAuth state

---

## Phase 6: Sync Progress & Event Architecture

**Goal:** Consolidate sync progress tracking in Rust. Replace localStorage-based progress service and frontend polling with Rust-managed state and push events.

**Depends on:** None (can run in parallel with Phases 3-5)

### 6.1 Rust-Side Sync Progress State

**File:** `src-tauri/src/sync_progress.rs` (new)

```rust
pub struct SyncProgressState {
    pub current_session: Option<SyncSession>,
    pub recent_files: Vec<RecentFile>,  // auto-expire after 1 hour
}

pub struct SyncSession {
    pub session_id: String,  // UUID v4 (not Math.random())
    pub started_at: Instant,
    pub is_active: bool,
    pub expected_uploads: u32,
    pub expected_downloads: u32,
    pub files: HashMap<String, SyncFileProgress>,
}

pub static SYNC_PROGRESS: Lazy<Mutex<SyncProgressState>> = ...;
```

### 6.2 New Rust Commands

| Command | Replaces | Description |
|---------|----------|-------------|
| `get_sync_progress` | `syncProgressService.getCurrentSessionFiles()` + `getRecentFiles()` + `getOverallProgress()` | Return complete sync progress state |
| `get_tray_menu_files` | `syncProgressService.getTrayMenuFiles()` | Return limited list for tray display |

### 6.3 Event-Driven Updates

Instead of the frontend polling `get_sync_activity` every 3 seconds:

- Rust emits `sync_progress_updated` event whenever file progress changes
- Rust emits `sync_health_changed` event only when health status changes (not on every poll)
- Frontend subscribes to events and updates UI reactively

Remove from frontend:
- `useSyncActivity` hook (3-second polling interval)
- `useSyncProgress` hook (localStorage reads + 60-second cleanup interval)

### 6.4 Frontend Changes

- **Remove:** `app/lib/services/syncProgressService.ts` (entire file — ~999 lines)
- **Remove:** `app/lib/hooks/useSyncProgress.ts` (~219 lines)
- **Simplify:** `app/lib/hooks/useSyncEvents.ts` — just listen to Rust events, update atoms directly
- **Remove:** All `localStorage` usage for `hippius_sync_progress`
- **Remove:** `Math.random()` session ID generation

### 6.5 Testing

- Test: sync progress state survives app restarts (persisted in Rust DB or rebuilt from events)
- Test: recent files auto-expire after 1 hour
- Test: tray menu shows correct limited file list
- Verify: zero `localStorage` keys related to sync progress

---

## Phase 7: Cleanup & Hardening

**Goal:** Remove all remaining frontend secrets, dead code, and unused dependencies. Harden the Rust backend.

### 7.1 Remove Hardcoded Secrets

- **Move** `HMAC_SECRET` from `config.ts` to `src-tauri/.env` (already loaded via `dotenvy`)
- **Move** all API base URLs to Rust (loaded from `.env` or compiled constants)
- **Verify** `config.ts` contains only UI-level configuration (no secrets, no API URLs)

### 7.2 Consolidate `config.ts`

After phases 1-6, `config.ts` should shrink dramatically:

```typescript
// Before: ~120 lines with API URLs, secrets, endpoint maps
// After: ~20 lines
export const config = {
  appName: "Hippius Desktop",
  deepLinkScheme: "hippiusapp",
  // UI-only config
  defaultSyncInterval: 30_000,
  maxTrayMenuFiles: 20,
};
```

### 7.3 Remove Unused Frontend Dependencies

After all phases, remove from `package.json`:

| Package | Reason |
|---------|--------|
| `@polkadot/api` | Blockchain queries moved to Rust |
| `@polkadot/keyring` | Key derivation moved to Rust |
| `@polkadot/util-crypto` | Mnemonic validation moved to Rust |
| `@polkadot/types` | Type definitions no longer needed in frontend |
| `@polkadot/rpc-provider` | WebSocket connection moved to Rust |
| `viem` | Ethereum signing moved to Rust |
| `crypto-js` | AES encryption moved to Rust |
| `sql.js` | Database operations moved to Rust |
| `axios` | HTTP calls moved to Rust |
| `bn.js` | BigNumber math moved to Rust |

### 7.4 Remove/Stub IPFS Mock Data

Either:
- **Implement** real IPFS node queries in Rust (`get_ipfs_node_info`, `get_ipfs_bandwidth`, `get_ipfs_peers`)
- **Or remove** the IPFS dashboard section from the UI and the mock commands

### 7.5 Implement Secure Storage for Mnemonic at Rest

Replace AES-with-passcode in SQLite with OS keychain:

```rust
// Use keyring crate for OS-level secure storage
use keyring::Entry;

pub fn store_encrypted_mnemonic(account_id: &str, encrypted: &str) -> Result<(), String> {
    let entry = Entry::new("hippius-desktop", account_id)
        .map_err(|e| e.to_string())?;
    entry.set_password(encrypted).map_err(|e| e.to_string())?;
    Ok(())
}
```

This provides:
- macOS: Keychain Access
- Windows: Credential Manager
- Linux: Secret Service (GNOME Keyring / KDE Wallet)

### 7.6 Final Frontend Architecture

After all phases, the frontend should be:

```
app/
├── (pages)/           # Route components (UI only)
├── components/        # Presentational components
├── lib/
│   ├── config.ts      # UI-only config (~20 lines)
│   ├── hooks/
│   │   ├── useAuth.ts           # Thin wrapper: invoke("get_session_info") etc.
│   │   ├── useVMInstances.ts    # useQuery + invoke("list_vm_instances")
│   │   ├── useStaking.ts        # useQuery + invoke("get_staking_info")
│   │   ├── useSyncEvents.ts     # listen() for Rust events → update atoms
│   │   └── ...                  # Each hook: 10-20 lines max
│   ├── store/
│   │   └── atoms.ts             # UI-only atoms (sidebar, dialogs)
│   └── wallet-auth-context.tsx  # ~100 lines: invoke-based auth state
```

**No more:**
- `services/` directory (all services → Rust commands)
- `helpers/crypto.ts`, `sessionStore.ts`, `hippiusDesktopDB.ts` (all → Rust)
- `api/indexerClient.ts` (→ Rust)
- `polkadot-api-context/` (→ Rust)
- Direct `fetch()` or `axios` calls anywhere

---

## Implementation Order & Dependencies

```
Phase 1 (Session Storage)
    │
    ├──→ Phase 2 (Auth & Crypto)
    │        │
    │        └──→ Phase 3 (Blockchain)
    │
    ├──→ Phase 4 (API Proxy)  ←── can start in parallel with Phase 2
    │        │
    │        └──→ Phase 5 (OAuth)
    │
    └──→ Phase 6 (Sync Progress)  ←── fully independent

Phase 7 (Cleanup) ←── after all others complete
```

**Recommended team parallelization:**
- **Track A:** Phase 1 → Phase 2 → Phase 3 (security-critical path)
- **Track B:** Phase 1 → Phase 4 → Phase 5 (API migration path)
- **Track C:** Phase 6 (independent, can start immediately)
- **Track D:** Phase 7 (final cleanup after A+B+C merge)

---

## Risk Mitigation

### Backward Compatibility

Each phase should maintain backward compatibility during migration:
1. New Rust commands added alongside existing frontend code
2. Frontend updated to use new commands (feature-flagged if needed)
3. Old frontend code removed only after new commands are verified
4. Database migrations are additive (new tables, not altered existing ones)

### Rollback Plan

- Each phase is a separate branch/PR
- Old frontend code preserved in git history
- Database migrations are forward-only but non-destructive
- Feature flags can toggle between old (frontend) and new (Rust) implementations during testing

### Security Audit Points

After each phase, verify:
- [ ] No sensitive data in `localStorage` or `sessionStorage`
- [ ] No private key material in frontend memory
- [ ] No hardcoded secrets in JS/TS bundle
- [ ] All HTTP requests go through Rust (check Network tab in DevTools)
- [ ] Token never appears in frontend console logs
- [ ] Mnemonic zeroized after use in Rust

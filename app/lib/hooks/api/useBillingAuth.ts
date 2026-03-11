import { invoke } from "@tauri-apps/api/core";

let __billingAuthInFlight: Promise<{ ok: boolean; error?: string }> | null = null;
let __billingAuthAccountId: string | null = null;

interface BillingAuthResult {
    token: string;
    user_id: number;
    username: string;
}

interface ApiAuth {
    token: string;
    tokenExpiry: number;
    userId: number | null;
    username: string | null;
}

export async function ensureBillingAuth(
    accountId: string,
    mnemonic?: string,
): Promise<{ ok: boolean; error?: string }> {
    // Only deduplicate concurrent calls for the same account
    if (__billingAuthInFlight && __billingAuthAccountId === accountId) {
        return __billingAuthInFlight;
    }

    __billingAuthAccountId = accountId;
    __billingAuthInFlight = (async () => {
        try {
            const existing = await invoke<ApiAuth | null>("get_auth_token", { accountId });
            if (existing && existing.token) {
                return { ok: true as const };
            }

            const result = await invoke<BillingAuthResult>("billing_auth", {
                accountId,
                mnemonic: mnemonic || null,
            });

            // Persist token in Rust DB
            await invoke("save_auth_session", {
                accountId,
                authToken: result.token,
                userId: result.user_id,
                username: result.username,
                provider: null,
                substrateAddress: accountId,
                logoutTimeMinutes: null,
                tokenExpiry: Date.now() + 24 * 60 * 60 * 1000, // 24h default
            });

            return { ok: true as const };
        } catch (e: unknown) {
            return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
        }
    })();

    try {
        return await __billingAuthInFlight;
    } finally {
        __billingAuthInFlight = null;
        __billingAuthAccountId = null;
    }
}

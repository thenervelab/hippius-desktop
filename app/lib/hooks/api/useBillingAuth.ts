import { invoke } from "@tauri-apps/api/core";
import { setApiAuth, getApiAuth } from "@/app/lib/helpers/sessionStore";

let __billingAuthInFlight: Promise<{ ok: boolean; error?: string }> | null = null;

interface BillingAuthResult {
    token: string;
    user_id: number;
    username: string;
}

export async function ensureBillingAuth(
    accountId: string,
    mnemonic?: string,
): Promise<{ ok: boolean; error?: string }> {
    if (__billingAuthInFlight) return __billingAuthInFlight;

    __billingAuthInFlight = (async () => {
        try {
            const existing = await getApiAuth();
            if (existing && existing.token && (!existing.tokenExpiry || existing.tokenExpiry > Date.now())) {
                return { ok: true as const };
            }

            const result = await invoke<BillingAuthResult>("billing_auth", {
                accountId,
                mnemonic: mnemonic || null,
            });
            await setApiAuth(result.token, { userId: result.user_id, username: result.username });
            return { ok: true as const };
        } catch (e: unknown) {
            return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
        }
    })();

    try {
        return await __billingAuthInFlight;
    } finally {
        __billingAuthInFlight = null;
    }
}

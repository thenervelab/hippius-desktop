import { Keyring } from "@polkadot/keyring";
import { mnemonicToAccount } from "viem/accounts";
import { API_CONFIG, setApiAuth, getApiAuth } from "@/app/lib/helpers/sessionStore";
import { getSession } from "@/app/lib/helpers/sessionStore";

const MAX_ATTEMPTS = 3;
let __billingAuthInFlight: Promise<{ ok: boolean; error?: string }> | null = null;

export async function ensureBillingAuth(): Promise<{ ok: boolean; error?: string }> {
    if (__billingAuthInFlight) return __billingAuthInFlight;

    __billingAuthInFlight = (async () => {
        try {
            const existing = await getApiAuth();
            if (existing && existing.token && (!existing.tokenExpiry || existing.tokenExpiry > Date.now())) {
                return { ok: true as const };
            }

            const session = await getSession();
            if (!session?.mnemonic) return { ok: false as const, error: "Not authenticated" };

            const keyring = new Keyring({ type: "sr25519" });
            const pair = keyring.addFromMnemonic(session.mnemonic);
            const ethAccount = mnemonicToAccount(session.mnemonic);
            const ethAddress = ethAccount.address;

            const baseUrl = API_CONFIG.baseUrl;
            const challengeUrl = `${baseUrl}${API_CONFIG.auth.mnemonic}`;
            const verifyUrl = `${baseUrl}${API_CONFIG.auth.verify}`;

            const attempt = async () => {
                const challengeRes = await fetch(challengeUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        "X-Requested-With": "XMLHttpRequest",
                    },
                    body: JSON.stringify({
                        address: ethAddress,
                        substrate_address: pair.address,
                    }),
                });
                if (!challengeRes.ok) {
                    const t = await challengeRes.text();
                    return { ok: false as const, error: `Challenge failed: ${challengeRes.status} ${t}` };
                }
                const { challenge, message } = await challengeRes.json();
                const signature = await ethAccount.signMessage({ message });
                const formattedSignature = signature.startsWith("0x") ? signature : `0x${signature}`;

                const verifyRes = await fetch(verifyUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        "X-Requested-With": "XMLHttpRequest",
                    },
                    body: JSON.stringify({
                        signature: formattedSignature,
                        address: ethAddress,
                        substrate_address: pair.address,
                        challenge,
                        referral_code: "",
                        session_data: {
                            challenge,
                            address: ethAddress,
                        },
                    }),
                });
                if (!verifyRes.ok) {
                    const t = await verifyRes.text();
                    return { ok: false as const, error: `Verify failed: ${verifyRes.status} ${t}` };
                }
                const data = await verifyRes.json();
                return { ok: true as const, data };
            };

            let lastErr: string | undefined;
            for (let i = 0; i < MAX_ATTEMPTS; i++) {
                const res = await attempt();
                if (res.ok) {
                    await setApiAuth(res.data.token, { userId: res.data.user_id, username: res.data.username });
                    return { ok: true as const };
                }
                lastErr = res.error;
            }

            return { ok: false as const, error: lastErr || "Verification failed" };
        } catch (e: unknown) {
            return { ok: false as const, error: e instanceof Error ? e.message : "Unknown error" };
        }
    })();

    try {
        return await __billingAuthInFlight;
    } finally {
        __billingAuthInFlight = null;
    }
}

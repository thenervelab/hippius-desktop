import { invoke } from "@tauri-apps/api/core";

/**
 * Shape returned by Rust `console_access_status`. Fields mirror
 * `ConsoleAccessStatus` in `src-tauri/src/console_access.rs`.
 */
export interface ConsoleAccessStatus {
    enabled: boolean;
    lastUpdatedAt: string | null;
    passkeyCount: number;
}

/**
 * Passphrase strength verdict from Rust. The frontend renders this
 * into a meter; all scoring rules live on the Rust side so the meter
 * label, threshold, and hints can evolve without a frontend change.
 */
export type PassphraseVerdict = "too_short" | "weak" | "ok" | "strong";

export interface PassphraseStrength {
    bits: number;
    verdict: PassphraseVerdict;
    /** User-facing label owned by Rust — "Too short", "Weak", "OK", "Strong". */
    label: string;
    /** 0–100 fill for the progress meter, clamped in Rust. */
    progressPercent: number;
    hints: string[];
    /**
     * Authoritative submit gate. The UI disables the submit button on
     * this value; Rust commands also re-check so a tampered frontend
     * can't bypass.
     */
    acceptableForSubmit: boolean;
}

export async function getConsoleAccessStatus(): Promise<ConsoleAccessStatus> {
    return invoke<ConsoleAccessStatus>("console_access_status");
}

export async function validateConsolePassphrase(
    passphrase: string,
): Promise<PassphraseStrength> {
    return invoke<PassphraseStrength>("validate_console_passphrase", { passphrase });
}

export async function enableConsoleAccess(
    passphrase: string,
    confirmedBackup: boolean,
): Promise<void> {
    await invoke("enable_console_access", { passphrase, confirmedBackup });
}

export async function rotateConsolePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
    confirmedBackup: boolean,
): Promise<void> {
    await invoke("rotate_console_passphrase", {
        oldPassphrase,
        newPassphrase,
        confirmedBackup,
    });
}

export async function disableConsoleAccess(): Promise<void> {
    await invoke("disable_console_access");
}

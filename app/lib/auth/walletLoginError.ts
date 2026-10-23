import { errorMessage } from "@/app/lib/utils/errorUtils";

/**
 * Start of the message Rust returns (`auth::service::verify_failure_message`)
 * when the API refuses a wallet that never proved its Substrate key: the one
 * login failure a retry does not fix, so the form shows it as is. Pinned to
 * the Rust text by `src-tauri/tests/auth_wiring_pins.rs`.
 */
export const WALLET_VERIFICATION_REQUIRED = "This wallet must be verified once";

const GENERIC = "Invalid access key. Please ensure you've entered a valid 12-word mnemonic phrase.";

/** What the access-key form shows for a failed `login_with_mnemonic`. */
export function walletLoginErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = errorMessage(error);
  return message.startsWith(WALLET_VERIFICATION_REQUIRED) ? message : GENERIC;
}

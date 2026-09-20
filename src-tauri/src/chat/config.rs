//! Chat feature gate and the fixed endpoints the webview client needs.
//!
//! The gate is decided here, in Rust, from the release channel baked into
//! the binary (`release_channel`), so the frontend cannot flip it and a
//! production build cannot be talked into showing chat by a bundled `.env`.
//! Staging builds get it on by default — that lane is the internal gate
//! where the feature is exercised — and the public lanes keep it off until
//! the channel flips [`CHAT_ENABLED_ON_PUBLIC_LANES`] in a release.
//!
//! Local `cargo build`s report the production channel (nothing sets
//! `HIPPIUS_RELEASE_CHANNEL`), which would hide the feature from every
//! developer; debug binaries therefore default to on. Either default can be
//! overridden at runtime with `HIPPIUS_CHAT_ENABLED=0|1`, the same escape
//! hatch shape the other env toggles use.

use serde::Serialize;

use crate::release_channel::{self, ReleaseChannel};

/// Whether the public lanes (beta, production) ship chat. Flipping this is
/// the one-line release change that turns the feature on for everyone.
pub const CHAT_ENABLED_ON_PUBLIC_LANES: bool = false;

/// Runtime override, read on every `chat_get_config` call.
const ENABLE_ENV_VAR: &str = "HIPPIUS_CHAT_ENABLED";

/// Matrix server name — the part after the colon in every user id.
pub const CHAT_SERVER_NAME: &str = "hippius.com";

/// Where `.well-known/matrix/client` discovery starts. This is the server
/// name as an https origin, per the Matrix spec.
pub const CHAT_DISCOVERY_ORIGIN: &str = "https://hippius.com";

/// Homeserver used when discovery fails or points somewhere unusable.
pub const CHAT_FALLBACK_BASE_URL: &str = "https://chat.hippius.com";

/// The community Space every account is offered on first sign-in.
pub const CHAT_COMMUNITY_SPACE_ALIAS: &str = "#hippius:hippius.com";

/// Client name shown by the identity provider on the consent page and in
/// the account's session list.
pub const CHAT_CLIENT_NAME: &str = "Hippius Desktop";

/// `client_uri` sent at dynamic client registration. The identity provider
/// requires it to be an https URL; it is informational.
pub const CHAT_CLIENT_URI: &str = "https://hippius.com/";

/// Pure decision, separated from the env read so it can be pinned.
pub fn chat_enabled_for(channel: ReleaseChannel, debug_build: bool, env_override: Option<&str>) -> bool {
    if let Some(raw) = env_override {
        let v = raw.trim();
        if v == "1" || v.eq_ignore_ascii_case("true") {
            return true;
        }
        if v == "0" || v.eq_ignore_ascii_case("false") {
            return false;
        }
        // Anything else is ignored rather than trusted either way.
    }
    match channel {
        ReleaseChannel::Staging => true,
        ReleaseChannel::Beta | ReleaseChannel::Production => CHAT_ENABLED_ON_PUBLIC_LANES || debug_build,
    }
}

/// Whether this binary exposes chat.
pub fn chat_enabled() -> bool {
    let env = std::env::var(ENABLE_ENV_VAR).ok();
    chat_enabled_for(release_channel::current(), cfg!(debug_assertions), env.as_deref())
}

/// Everything the webview needs to know before it opens a client. All of it
/// is decided here so the frontend carries no copy of these constants.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfig {
    pub enabled: bool,
    pub server_name: &'static str,
    pub fallback_base_url: &'static str,
    pub community_space_alias: &'static str,
    /// Fixed secret-storage key id (see `keys::CHAT_4S_KEY_ID`).
    pub secret_storage_key_id: &'static str,
    /// Display name for the published key description.
    pub secret_storage_key_name: &'static str,
    /// Origin of the Hippius API; the GIF and workspace-invite proxies live
    /// there. Reported so the frontend can label errors, not so it can call
    /// the API itself — those calls go through the `chat_*` commands.
    pub api_base_url: String,
}

/// Snapshot the chat configuration for the frontend.
#[tauri::command]
pub fn chat_get_config() -> ChatConfig {
    ChatConfig {
        enabled: chat_enabled(),
        server_name: CHAT_SERVER_NAME,
        fallback_base_url: CHAT_FALLBACK_BASE_URL,
        community_space_alias: CHAT_COMMUNITY_SPACE_ALIAS,
        secret_storage_key_id: super::keys::CHAT_4S_KEY_ID,
        secret_storage_key_name: super::keys::CHAT_4S_KEY_NAME,
        api_base_url: crate::api::client::api_base_url(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_is_on_by_default_and_public_lanes_follow_the_release_switch() {
        assert!(chat_enabled_for(ReleaseChannel::Staging, false, None));
        assert_eq!(chat_enabled_for(ReleaseChannel::Beta, false, None), CHAT_ENABLED_ON_PUBLIC_LANES);
        assert_eq!(chat_enabled_for(ReleaseChannel::Production, false, None), CHAT_ENABLED_ON_PUBLIC_LANES);
    }

    #[test]
    fn debug_builds_see_the_feature_on_every_channel() {
        // A local `cargo build` reports Production; developers must still
        // reach the feature.
        assert!(chat_enabled_for(ReleaseChannel::Production, true, None));
        assert!(chat_enabled_for(ReleaseChannel::Beta, true, None));
    }

    #[test]
    fn env_override_wins_in_both_directions_and_garbage_is_ignored() {
        assert!(chat_enabled_for(ReleaseChannel::Production, false, Some("1")));
        assert!(chat_enabled_for(ReleaseChannel::Production, false, Some(" true ")));
        assert!(!chat_enabled_for(ReleaseChannel::Staging, false, Some("0")));
        assert!(!chat_enabled_for(ReleaseChannel::Staging, false, Some("FALSE")));
        // Unrecognised values fall through to the channel default.
        assert!(chat_enabled_for(ReleaseChannel::Staging, false, Some("yes please")));
        assert_eq!(
            chat_enabled_for(ReleaseChannel::Production, false, Some("")),
            CHAT_ENABLED_ON_PUBLIC_LANES
        );
    }

    #[test]
    fn config_carries_the_shared_key_id() {
        let cfg = chat_get_config();
        assert_eq!(cfg.secret_storage_key_id, "hippius-console-v1");
        assert_eq!(cfg.server_name, "hippius.com");
        assert_eq!(cfg.community_space_alias, "#hippius:hippius.com");
    }
}

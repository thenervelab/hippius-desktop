//! Which release lane produced this binary, and where that lane publishes updates.
//!
//! Three lanes, promoted by squash at each hop:
//!
//! ```text
//! staging (internal) -> beta (public opt-in) -> main (production)
//! ```
//!
//! The channel is baked in AT COMPILE TIME by the workflow that builds the lane,
//! which is what makes it trustworthy: the channel is a property of the BINARY,
//! so nothing in a bundled `.env` — a file that can be copied between lanes —
//! can claim a build is something it is not. The same reasoning previously kept
//! the share-link console origin honest, which is where this const lived until
//! the channel gained consumers beyond that one decision.
//!
//! **There is deliberately no persisted "preferred channel".** Switching channel
//! installs the other lane's build, and that build reports its own channel from
//! the constant below. There is no second copy of the answer to drift out of
//! sync with the binary that is actually running.

use serde::Serialize;

/// Release channel baked in at compile time. `tauri-staging.yml` exports
/// `HIPPIUS_RELEASE_CHANNEL=staging` and `tauri-beta.yml` exports `beta`; the
/// production workflow and every local `cargo build` leave it unset.
const RELEASE_CHANNEL: Option<&str> = option_env!("HIPPIUS_RELEASE_CHANNEL");

/// Update manifest for the production lane.
///
/// GitHub resolves `releases/latest` to the newest NON-prerelease, which is
/// exactly the production release and never a beta or staging one.
const PRODUCTION_MANIFEST_URL: &str = "https://github.com/thenervelab/hippius-desktop/releases/latest/download/latest.json";

/// Update manifest for the beta lane.
///
/// A fixed tag rather than a per-version one: every beta release carries its own
/// tag (`v0.5.0-beta.3`), and `releases/latest` cannot point at a prerelease, so
/// neither gives a stable URL to check. `tauri-beta.yml` overwrites this one
/// asset on every build; the manifest's own `url` fields address the real
/// versioned release assets.
///
/// The tag is `beta-channel`, NOT `beta`: a tag sharing the branch name makes
/// `git push origin beta` fail with "src refspec beta matches more than one"
/// and every `git checkout beta` ambiguous, breaking the promotion flow this
/// lane exists for.
const BETA_MANIFEST_URL: &str = "https://github.com/thenervelab/hippius-desktop/releases/download/beta-channel/latest.json";

/// The release lane a build came from.
///
/// Serialized lowercase for the frontend, matching the tagged-state convention
/// the other FE-facing enums use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseChannel {
    Production,
    Beta,
    Staging,
}

impl ReleaseChannel {
    /// Where this channel publishes its update manifest, if it publishes one.
    ///
    /// `Staging` is `None` on purpose. Nothing switches into staging — it is the
    /// internal gate, installed by hand — so it has no auto-update story, and
    /// saying so in the type stops a caller from inventing one. This also
    /// retires a live defect: staging builds used to be given the staging
    /// updater *pubkey* while keeping the production *endpoint*, so every check
    /// fetched the production manifest and failed signature verification, which
    /// surfaces as "no update available" rather than as a misconfiguration.
    pub fn manifest_url(self) -> Option<&'static str> {
        match self {
            ReleaseChannel::Production => Some(PRODUCTION_MANIFEST_URL),
            ReleaseChannel::Beta => Some(BETA_MANIFEST_URL),
            ReleaseChannel::Staging => None,
        }
    }
}

/// Parse the baked channel string.
///
/// Anything unrecognized — unset, empty, or a typo — is Production, the
/// fail-safe direction: a mis-set channel behaves like a release build rather
/// than exposing a user to a prerelease lane's behaviour.
pub fn parse_release_channel(raw: Option<&str>) -> ReleaseChannel {
    match raw.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("staging") => ReleaseChannel::Staging,
        Some(value) if value.eq_ignore_ascii_case("beta") => ReleaseChannel::Beta,
        _ => ReleaseChannel::Production,
    }
}

/// The channel this binary was built as.
pub fn current() -> ReleaseChannel {
    parse_release_channel(RELEASE_CHANNEL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_channel() {
        assert_eq!(parse_release_channel(Some("staging")), ReleaseChannel::Staging);
        assert_eq!(parse_release_channel(Some("beta")), ReleaseChannel::Beta);
        // Whitespace and casing are tolerated: the value comes from a workflow
        // env line, where both are easy to introduce and neither is meaningful.
        assert_eq!(parse_release_channel(Some("  Staging ")), ReleaseChannel::Staging);
        assert_eq!(parse_release_channel(Some("BETA")), ReleaseChannel::Beta);
    }

    #[test]
    fn parses_fail_safe_to_production() {
        // Unset, empty, or a typo all land on Production — the direction that
        // can never hand a real user a prerelease lane's behaviour.
        assert_eq!(parse_release_channel(None), ReleaseChannel::Production);
        assert_eq!(parse_release_channel(Some("")), ReleaseChannel::Production);
        assert_eq!(parse_release_channel(Some("   ")), ReleaseChannel::Production);
        assert_eq!(parse_release_channel(Some("stagging")), ReleaseChannel::Production);
        assert_eq!(parse_release_channel(Some("bета")), ReleaseChannel::Production);
        assert_eq!(parse_release_channel(Some("production")), ReleaseChannel::Production);
    }

    /// The two public lanes must not share a manifest: pointing beta at the
    /// production URL is how a channel switch silently becomes a no-op, and
    /// pointing production at beta would push prereleases to everyone.
    #[test]
    fn the_public_channels_have_distinct_manifests() {
        let production = ReleaseChannel::Production.manifest_url().expect("production publishes a manifest");
        let beta = ReleaseChannel::Beta.manifest_url().expect("beta publishes a manifest");

        assert_ne!(production, beta);
        assert!(production.starts_with("https://"), "manifests are fetched over TLS");
        assert!(beta.starts_with("https://"), "manifests are fetched over TLS");
    }

    /// `releases/latest` resolves only to a non-prerelease, so the beta manifest
    /// cannot use it — a beta build checking that URL would be offered the
    /// production release instead of the newest beta.
    #[test]
    fn the_beta_manifest_does_not_use_the_latest_alias() {
        let beta = ReleaseChannel::Beta.manifest_url().expect("beta publishes a manifest");

        assert!(
            !beta.contains("/releases/latest/"),
            "beta releases are prereleases, which /releases/latest never resolves to"
        );
    }

    /// Staging is installed by hand and never switched into, so it has no
    /// manifest. A `Some` here would resurrect the endpoint/pubkey mismatch
    /// that made staging update checks fail silently.
    #[test]
    fn staging_publishes_no_manifest() {
        assert_eq!(ReleaseChannel::Staging.manifest_url(), None);
    }

    /// Wire-shape pin: the frontend switches on these strings, and there is no
    /// codegen to catch a rename.
    #[test]
    fn serializes_to_lowercase_names() {
        let json = |channel: ReleaseChannel| serde_json::to_value(channel).expect("serialize");

        assert_eq!(json(ReleaseChannel::Production), serde_json::json!("production"));
        assert_eq!(json(ReleaseChannel::Beta), serde_json::json!("beta"));
        assert_eq!(json(ReleaseChannel::Staging), serde_json::json!("staging"));
    }
}

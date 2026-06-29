//! Resolution of the mesh connection config (management URL + desktop-peer
//! credential).
//!
//! The management URL is the self-hosted NetBird server — not a secret, so it
//! defaults to [`DEFAULT_MANAGEMENT_URL`] (overridable via env for staging).
//! The per-tenant credential (a NetBird setup key / JWT) is **minted by the
//! Hippius backend**. That endpoint does not exist yet, so the backend lookup
//! returns [`VpnError::NotConfigured`] and we fall back to a **dev/manual**
//! setup key from the environment — letting the embedded engine be tested
//! against the live control plane before the backend mint lands. With neither
//! source, the VPN stays unconfigured by design.

use crate::app_state::AppState;
use crate::vpn::engine::MeshConfig;
use crate::vpn::error::VpnError;

/// Self-hosted Hippius NetBird control-plane URL. Public information; the
/// secret is the per-tenant credential, not this.
pub const DEFAULT_MANAGEMENT_URL: &str = "https://netbird.hippius.com";

/// Optional override of the management URL (e.g. a staging control plane).
const ENV_MANAGEMENT_URL: &str = "HIPPIUS_NETBIRD_MANAGEMENT_URL";

/// Dev/manual setup key, used only until the backend mint endpoint exists. A
/// human creates a one-off key in the NetBird dashboard and exports it to test
/// an embedded build against the control plane. NOT a shipping path.
const ENV_SETUP_KEY: &str = "HIPPIUS_NETBIRD_SETUP_KEY";

/// Resolve the mesh config for the current session.
pub(crate) async fn resolve_mesh_config(state: &AppState) -> Result<MeshConfig, VpnError> {
    let management_url = std::env::var(ENV_MANAGEMENT_URL)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MANAGEMENT_URL.to_string());

    // Use the app's device-name source (user-settable, hostname-seeded) so the
    // NetBird peer name matches the identity the rest of the app maintains and
    // the backend can locate the just-enrolled peer — rather than re-deriving a
    // raw OS hostname inside the engine.
    let pool = state.pool().map_err(|e| VpnError::Engine(e.to_string()))?;
    let device_name = crate::sync::device::get_device_name_internal(pool)
        .await
        .map_err(|e| VpnError::Engine(e.to_string()))?;

    let backend = match fetch_backend_credential(state).await {
        Ok(cred) => Some(cred),
        // Backend not available yet — fall through to the dev override.
        Err(VpnError::NotConfigured) => None,
        Err(e) => return Err(e),
    };
    let dev = std::env::var(ENV_SETUP_KEY).ok();

    let credential = choose_credential(backend, dev)?;
    Ok(MeshConfig {
        management_url,
        credential,
        device_name,
    })
}

/// Pure credential-precedence policy: the backend-minted credential wins; else a
/// non-empty dev override; else [`VpnError::NotConfigured`]. Separated from the
/// IO sources above so the precedence is unit-testable without touching env or
/// the network.
fn choose_credential(backend: Option<String>, dev: Option<String>) -> Result<String, VpnError> {
    if let Some(cred) = backend.filter(|s| !s.trim().is_empty()) {
        return Ok(cred);
    }
    if let Some(cred) = dev.filter(|s| !s.trim().is_empty()) {
        return Ok(cred);
    }
    Err(VpnError::NotConfigured)
}

/// Fetch the per-tenant NetBird enrollment credential for the logged-in account
/// from the Hippius backend.
///
/// TODO(vpn, Phase 4): call the Hippius backend endpoint that mints a per-tenant
/// NetBird setup key / JWT for this account (auto-assigned to the tenant's VM
/// group). Until that exists the backend source is absent by design — the
/// desktop never fabricates a credential and never embeds a shared one; the
/// dev-env override above is the only stand-in, and only for manual testing.
async fn fetch_backend_credential(_state: &AppState) -> Result<String, VpnError> {
    Err(VpnError::NotConfigured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_credential_wins_over_dev() {
        let got = choose_credential(Some("backend-key".into()), Some("dev-key".into())).expect("ok");
        assert_eq!(got, "backend-key");
    }

    #[test]
    fn dev_override_used_when_backend_absent() {
        let got = choose_credential(None, Some("dev-key".into())).expect("ok");
        assert_eq!(got, "dev-key");
    }

    #[test]
    fn blank_sources_are_ignored() {
        // An empty or whitespace value from either source must not count as a
        // credential — it would produce a useless enrollment attempt.
        assert!(matches!(
            choose_credential(Some("   ".into()), Some(String::new())),
            Err(VpnError::NotConfigured)
        ));
    }

    #[test]
    fn blank_backend_falls_through_to_dev() {
        let got = choose_credential(Some("  ".into()), Some("dev-key".into())).expect("ok");
        assert_eq!(got, "dev-key");
    }

    #[test]
    fn no_sources_is_not_configured() {
        assert!(matches!(choose_credential(None, None), Err(VpnError::NotConfigured)));
    }
}

//! "Ask for email" on a file link: the owner's side of an email gate.
//!
//! A gated link asks a viewer to confirm an email with a mailed code before
//! it opens, optionally only for the addresses and domains on an allow list,
//! and never for those on a block list. The viewer's side (the email and
//! code screens) is the console's share page; this is the owner's.
//!
//! Server routes (owner bearer, all behind `share_gates`):
//!
//! - `PUT /v1/shares/{token}/gate` `{allow, block, sealed_lists}`: set or
//!   replace the gate. The lists go in plaintext once, so the server can keep
//!   keyed hashes of them, with a copy sealed on this device so any of the
//!   owner's devices can show them again. Needs a paid Drive plan.
//! - `GET .../gate`: `{allow_count, block_count, sealed_lists}`, or the
//!   bodiless 404 for a link with no gate.
//! - `DELETE .../gate`: remove it, on any plan.
//!
//! The sealed copy is the console's format, byte for byte, so a list saved in
//! either app opens in the other:
//!
//! ```text
//! version(1) || nonce(24) || XChaCha20-Poly1305(JSON {"allow": [...], "block": [...]})
//!   key: the owner wrap key (`owner_wrap::derive_wrap_key`)
//!   AAD: "hippius.share-gate-lists.v1" || 0x00 || owner_ss58 || 0x00 || token
//! ```
//!
//! Its own context keeps a sealed list from ever opening as an owner wrap
//! (whose additional data starts with the owner's address) and binds it to
//! its link.

use std::collections::HashSet;
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tracing::debug;
use zeroize::Zeroizing;

use super::insights::{
    Api, LINK_GONE, PLAN_UNREADABLE, REQUEST_TIMEOUT, UNREACHABLE, capabilities_checked, read_ok, read_switches_in_plan, transport,
};
use super::owner_wrap::{WrapKey, derive_wrap_key};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// The most entries one list takes (hcfs `MAX_GATE_ENTRIES`).
pub const MAX_GATE_ENTRIES: usize = 500;
/// The longest entry the server takes, in bytes.
pub const MAX_GATE_ENTRY_LEN: usize = 254;

/// The sealed copy's context, shared with the console.
pub const GATE_LISTS_CONTEXT: &str = "hippius.share-gate-lists.v1";
const SEAL_VERSION: u8 = 1;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;

/// Refused on the free plan, in the upgrade prompt's words (the app shows
/// the prompt for it, matched word for word).
pub const GATE_NOT_IN_PLAN: &str = "Asking for an email is available on paid Drive plans.";
const GATE_UNAVAILABLE: &str = "Asking for an email isn't available yet.";
const CHECK_THE_LISTS: &str = "Check the lists and try again.";
const LISTS_NOT_HERE: &str = "Couldn't open your lists on this computer. Try again.";

/// An email gate's two lists, as the owner edits them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateLists {
    pub allow: Vec<String>,
    pub block: Vec<String>,
}

/// A link's email gate as the owner sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkGate {
    /// The server has email gates (`share_gates`). Without it nothing else is
    /// set, and the app shows no "Ask for email".
    pub offered: bool,
    pub on: bool,
    pub allow_count: u32,
    pub block_count: u32,
    /// The lists, opened from the owner's sealed copy. `None` while off, and
    /// when the copy cannot be opened on this computer (the app then shows
    /// only the counts).
    pub lists: Option<GateLists>,
    /// Whether the plan includes it: `Some(false)` on the free plan, where
    /// turning it on shows the upgrade prompt; `None` when the plan could not
    /// be read (nothing is locked, and the server still checks).
    pub in_plan: Option<bool>,
}

// ─── The lists ─────────────────────────────────────────────────────────────

/// The entries in what the owner typed: split on commas, semicolons, spaces
/// and new lines, trimmed, lowercased, and each kept once in the order typed.
#[must_use]
pub fn parse_entries(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '\u{FEFF}')
        .map(|raw| raw.trim().to_lowercase())
        .filter(|entry| !entry.is_empty() && seen.insert(entry.clone()))
        .collect()
}

static DOMAIN_LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$").expect("a fixed pattern"));

fn looks_like_domain(domain: &str) -> bool {
    let trimmed = domain.strip_suffix('.').unwrap_or(domain);
    let labels: Vec<&str> = trimmed.split('.').collect();
    labels.len() >= 2 && labels.iter().all(|label| DOMAIN_LABEL.is_match(label))
}

/// Whether `entry` reads as an address (`name@acme.com`) or a domain
/// (`acme.com` or `@acme.com`). A first check, the console's, so a typo is
/// caught before saving; the server parses every entry again and has the
/// last word.
#[must_use]
pub fn is_gate_entry(entry: &str) -> bool {
    if entry.is_empty() || entry.len() > MAX_GATE_ENTRY_LEN {
        return false;
    }
    let Some((local, domain)) = entry.split_once('@') else {
        return looks_like_domain(entry);
    };
    if domain.contains('@') {
        return false;
    }
    if !local.is_empty() && (local.chars().any(|c| c.is_whitespace() || c.is_control()) || local.starts_with('+')) {
        return false;
    }
    looks_like_domain(domain)
}

/// What is wrong with `entry`, in the words the owner sees.
fn not_an_entry(entry: &str) -> String {
    format!("\"{entry}\" isn't an email address or a domain.")
}

/// The lists to send from what the owner typed, or why they cannot be.
fn lists_from_text(allow: &str, block: &str) -> Result<GateLists> {
    let lists = GateLists {
        allow: parse_entries(allow),
        block: parse_entries(block),
    };
    if let Some(bad) = lists.allow.iter().chain(&lists.block).find(|e| !is_gate_entry(e)) {
        return Err(AppError::Validation(not_an_entry(bad)));
    }
    if lists.allow.len() > MAX_GATE_ENTRIES || lists.block.len() > MAX_GATE_ENTRIES {
        return Err(AppError::Validation(format!("Each list takes up to {MAX_GATE_ENTRIES} entries.")));
    }
    Ok(lists)
}

/// The entry a server `400` names (`allow[3] ...`), from the lists sent.
fn entry_named_by(message: &str, lists: &GateLists) -> Option<String> {
    static NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(allow|block)\[(\d+)\]").expect("a fixed pattern"));
    let caps = NAMED.captures(message)?;
    let list = if &caps[1] == "allow" { &lists.allow } else { &lists.block };
    list.get(caps[2].parse::<usize>().ok()?).cloned()
}

// ─── The sealed copy ───────────────────────────────────────────────────────

fn lists_aad(owner_ss58: &str, token: &str) -> Vec<u8> {
    [GATE_LISTS_CONTEXT, owner_ss58, token].join("\0").into_bytes()
}

/// Seal `lists` under the owner wrap key with `nonce`.
fn seal_lists_with_nonce(
    key: &WrapKey,
    owner_ss58: &str,
    token: &str,
    lists: &GateLists,
    nonce: &[u8; NONCE_LEN],
) -> std::result::Result<String, String> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(&serde_json::json!({ "allow": lists.allow, "block": lists.block })).map_err(|e| e.to_string())?);
    let aad = lists_aad(owner_ss58, token);
    let ciphertext = XChaCha20Poly1305::new((&**key).into())
        .encrypt(XNonce::from_slice(nonce), Payload { msg: &plaintext, aad: &aad })
        .map_err(|_| "seal failed".to_string())?;
    let mut sealed = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    sealed.push(SEAL_VERSION);
    sealed.extend_from_slice(nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(sealed))
}

fn seal_lists(key: &WrapKey, owner_ss58: &str, token: &str, lists: &GateLists) -> std::result::Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_lists_with_nonce(key, owner_ss58, token, lists, &nonce)
}

/// Open a sealed copy, or `None` when it does not open (another owner,
/// another link, another key, a changed byte, an unknown version). Anything
/// in it that is not a string is left out.
fn open_lists(key: &WrapKey, owner_ss58: &str, token: &str, sealed_b64: &str) -> Option<GateLists> {
    let sealed = STANDARD.decode(sealed_b64.trim()).ok()?;
    if sealed.len() < 1 + NONCE_LEN + TAG_LEN || sealed[0] != SEAL_VERSION {
        return None;
    }
    let aad = lists_aad(owner_ss58, token);
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new((&**key).into())
            .decrypt(
                XNonce::from_slice(&sealed[1..=NONCE_LEN]),
                Payload {
                    msg: &sealed[1 + NONCE_LEN..],
                    aad: &aad,
                },
            )
            .ok()?,
    );
    let value: serde_json::Value = serde_json::from_slice(&plaintext).ok()?;
    let strings = |key: &str| -> Vec<String> {
        value
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    Some(GateLists {
        allow: strings("allow"),
        block: strings("block"),
    })
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

/// A gate as the server reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
struct WireGate {
    #[serde(default)]
    allow_count: u32,
    #[serde(default)]
    block_count: u32,
    #[serde(default)]
    sealed_lists: String,
}

fn parse_gate(body: &str) -> Result<WireGate> {
    serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("gate parse failed: {e}")))
}

/// The link's gate, or `None` when it has none (the bodiless 404).
async fn get_gate(http: &reqwest::Client, api: &Api, token: &str) -> Result<Option<WireGate>> {
    let resp = http
        .get(api.share_url(token, "/gate")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("gate", e))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    parse_gate(&read_ok(resp).await?).map(Some)
}

async fn put_gate(http: &reqwest::Client, api: &Api, token: &str, lists: &GateLists, sealed_lists: &str) -> Result<WireGate> {
    let resp = http
        .put(api.share_url(token, "/gate")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "allow": lists.allow, "block": lists.block, "sealed_lists": sealed_lists }))
        .send()
        .await
        .map_err(|e| transport("gate", e))?;
    let body = read_ok(resp).await.map_err(|e| gate_refusal(e, lists))?;
    parse_gate(&body)
}

/// Remove the gate. A link that already has none is what was asked for.
async fn delete_gate(http: &reqwest::Client, api: &Api, token: &str) -> Result<()> {
    let resp = http
        .delete(api.share_url(token, "/gate")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("gate", e))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    read_ok(resp).await.map(|_| ())
}

/// The server's refusals of a gate, in the app's words: the plan, a plan it
/// could not read, and an entry it would not take (named when it says which).
fn gate_refusal(err: AppError, lists: &GateLists) -> AppError {
    let AppError::Api { status, body } = &err else {
        return err;
    };
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let field = |k: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(k))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    match (*status, field("error").as_deref()) {
        (403, Some("paid_plan_required")) => AppError::Validation(GATE_NOT_IN_PLAN.into()),
        (502, Some("billing_unavailable")) => AppError::Validation(PLAN_UNREADABLE.into()),
        (400, _) => AppError::Validation(
            field("message")
                .and_then(|m| entry_named_by(&m, lists))
                .map_or_else(|| CHECK_THE_LISTS.to_string(), |entry| not_an_entry(&entry)),
        ),
        _ => err,
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// The owner wrap key for the signed-in account, or `None` when its
/// passphrase cannot be read here.
async fn wrap_key_for(state: &AppState, account_id: &str) -> Option<WrapKey> {
    let mnemonic = crate::sync::mnemonic::get_mnemonic_for_account(state, account_id).await.ok()?;
    derive_wrap_key(mnemonic.as_str()).ok()
}

fn gate_on(wire: &WireGate, lists: Option<GateLists>, in_plan: Option<bool>) -> LinkGate {
    LinkGate {
        offered: true,
        on: true,
        allow_count: wire.allow_count,
        block_count: wire.block_count,
        lists,
        in_plan,
    }
}

/// A file link's email gate, for the share dialog and Link settings.
#[tauri::command]
pub async fn share_get_gate(state: tauri::State<'_, AppState>, share_token: String) -> Result<LinkGate> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_gates {
        return Ok(LinkGate::default());
    }
    let api = Api::for_account(&state, &account_id).await?;
    let (gate, in_plan) = tokio::join!(
        get_gate(&state.api_client, &api, &share_token),
        read_switches_in_plan(&state, &account_id)
    );
    let Some(wire) = gate? else {
        return Ok(LinkGate {
            offered: true,
            in_plan,
            ..LinkGate::default()
        });
    };
    let lists = if wire.sealed_lists.is_empty() {
        None
    } else {
        match wrap_key_for(&state, &account_id).await {
            Some(key) => open_lists(&key, &account_id, &share_token, &wire.sealed_lists),
            None => None,
        }
    };
    if lists.is_none() {
        debug!("share gate: the sealed lists could not be opened here");
    }
    Ok(gate_on(&wire, lists, in_plan))
}

/// Turn the gate on or save its lists, from what the owner typed in each
/// box (empty for anyone with an email). Needs a paid Drive plan.
#[tauri::command]
pub async fn share_set_gate(state: tauri::State<'_, AppState>, share_token: String, allow: String, block: String) -> Result<LinkGate> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_gates {
        return Err(AppError::Validation(GATE_UNAVAILABLE.into()));
    }
    let lists = lists_from_text(&allow, &block)?;
    let in_plan = read_switches_in_plan(&state, &account_id).await;
    if in_plan == Some(false) {
        return Err(AppError::Validation(GATE_NOT_IN_PLAN.into()));
    }
    let key = wrap_key_for(&state, &account_id)
        .await
        .ok_or_else(|| AppError::Validation(LISTS_NOT_HERE.into()))?;
    let sealed = seal_lists(&key, &account_id, &share_token, &lists).map_err(|_| AppError::Validation(LISTS_NOT_HERE.into()))?;
    let api = Api::for_account(&state, &account_id).await?;
    let wire = put_gate(&state.api_client, &api, &share_token, &lists, &sealed).await?;
    Ok(gate_on(&wire, Some(lists), in_plan))
}

/// Remove the gate, on any plan, so an owner who downgraded can always open
/// a link back up.
#[tauri::command]
pub async fn share_remove_gate(state: tauri::State<'_, AppState>, share_token: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_gates {
        return Err(AppError::Validation(GATE_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    delete_gate(&state.api_client, &api, &share_token).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound(LINK_GONE.into()),
        other => other,
    })
}

#[cfg(test)]
mod tests {
    use super::super::insights::tests::mock;
    use super::*;

    const OWNER: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const TOKEN: &str = "tok_abcdefghijklmnopqrst";

    fn key(byte: u8) -> WrapKey {
        Zeroizing::new([byte; 32])
    }

    fn lists() -> GateLists {
        GateLists {
            allow: vec!["alice@acme.com".into(), "acme.com".into()],
            block: vec!["mallory@acme.com".into()],
        }
    }

    #[test]
    fn entries_split_lowercase_and_keep_each_once() {
        assert_eq!(
            parse_entries(" Alice@Acme.com, acme.com;\nBOB@x.io  acme.com\n\n"),
            ["alice@acme.com", "acme.com", "bob@x.io"]
        );
        assert!(parse_entries("  \n ").is_empty());
    }

    #[test]
    fn an_entry_is_an_address_or_a_domain() {
        for ok in [
            "alice@acme.com",
            "alice+deals@acme.com",
            "acme.com",
            "@acme.com",
            "bücher.example",
            "a@sub.acme.co.uk",
            "acme.com.",
        ] {
            assert!(is_gate_entry(ok), "{ok}");
        }
        let long = format!("{}@acme.com", "a".repeat(250));
        for bad in [
            "",
            "acme",
            "a@b@acme.com",
            "+x@acme.com",
            "a@-acme.com",
            "a@acme",
            "a b@acme.com",
            long.as_str(),
        ] {
            assert!(!is_gate_entry(bad), "{bad:?}");
        }
    }

    #[test]
    fn typed_lists_are_checked_before_anything_is_sent() {
        assert_eq!(lists_from_text("Alice@acme.com\nacme.com", "mallory@acme.com").unwrap(), lists());
        assert!(matches!(lists_from_text("acme.com", "nope"), Err(AppError::Validation(m)) if m == "\"nope\" isn't an email address or a domain."));
        let many = (0..=MAX_GATE_ENTRIES).map(|i| format!("u{i}@acme.com")).collect::<Vec<_>>().join("\n");
        assert!(matches!(lists_from_text(&many, ""), Err(AppError::Validation(m)) if m.contains("500")));
        assert_eq!(
            lists_from_text("", "").unwrap(),
            GateLists::default(),
            "empty boxes: anyone with an email"
        );
    }

    /// The console seals the same lists to these exact bytes (its
    /// `sealGateListsWithKey` with this key, owner, link and nonce), so a list
    /// saved in either app opens in the other.
    #[test]
    fn the_sealed_copy_matches_the_consoles_bytes() {
        const CONSOLE: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAcpWYiGlg5q9B7C14ktiNOj3JvFIwVpowNw9kxcBihQqUY0gGa7QYWMQrQW296zbe91Nkel8Is1ibe4dry8YPa2W8OOclNAz59ohxoor/xNeRzsA3A==";
        assert_eq!(seal_lists_with_nonce(&key(7), OWNER, TOKEN, &lists(), &[1; NONCE_LEN]).unwrap(), CONSOLE);
        assert_eq!(open_lists(&key(7), OWNER, TOKEN, CONSOLE), Some(lists()));
    }

    #[test]
    fn a_sealed_copy_opens_only_for_its_owner_link_and_key() {
        let sealed = seal_lists(&key(7), OWNER, TOKEN, &lists()).unwrap();
        assert_eq!(open_lists(&key(7), OWNER, TOKEN, &sealed), Some(lists()));
        assert_ne!(sealed, seal_lists(&key(7), OWNER, TOKEN, &lists()).unwrap(), "a fresh nonce each time");
        assert_eq!(open_lists(&key(7), OWNER, "tok_another_link_123456", &sealed), None);
        assert_eq!(
            open_lists(&key(7), "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", TOKEN, &sealed),
            None
        );
        assert_eq!(open_lists(&key(8), OWNER, TOKEN, &sealed), None);

        let mut bytes = STANDARD.decode(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert_eq!(open_lists(&key(7), OWNER, TOKEN, &STANDARD.encode(&bytes)), None, "a changed byte");
        let mut bytes = STANDARD.decode(&sealed).unwrap();
        bytes[0] = 2;
        assert_eq!(open_lists(&key(7), OWNER, TOKEN, &STANDARD.encode(&bytes)), None, "another version");
        assert_eq!(open_lists(&key(7), OWNER, TOKEN, "not base64"), None);
    }

    #[test]
    fn the_servers_refusals_read_in_the_apps_words() {
        let api = |status, body: &str| AppError::Api {
            status,
            body: body.to_string(),
        };
        let l = lists();
        assert!(matches!(gate_refusal(api(403, r#"{"error":"paid_plan_required"}"#), &l), AppError::Validation(m) if m == GATE_NOT_IN_PLAN));
        assert!(matches!(gate_refusal(api(502, r#"{"error":"billing_unavailable"}"#), &l), AppError::Validation(m) if m == PLAN_UNREADABLE));
        assert!(matches!(
            gate_refusal(api(400, r#"{"error":"bad_request","message":"block[0] does not end in a domain"}"#), &l),
            AppError::Validation(m) if m == "\"mallory@acme.com\" isn't an email address or a domain."
        ));
        assert!(
            matches!(gate_refusal(api(400, r#"{"error":"bad_request","message":"allow[9] is empty"}"#), &l), AppError::Validation(m) if m == CHECK_THE_LISTS)
        );
        assert!(matches!(gate_refusal(api(500, "boom"), &l), AppError::Api { status: 500, .. }));
    }

    #[tokio::test]
    async fn the_gate_is_read_set_and_removed_on_the_links_route() {
        let (base, seen) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("GET" | "DELETE", "/v1/shares/ungated/gate") => (404, String::new()),
            ("GET" | "PUT", _) => (200, r#"{"allow_count":2,"block_count":1,"sealed_lists":"AQ=="}"#.into()),
            _ => (204, String::new()),
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "owner-bearer"));

        assert_eq!(get_gate(&http, &api, "ungated").await.unwrap(), None, "no gate is the bodiless 404");
        let got = get_gate(&http, &api, "tok_1").await.unwrap().unwrap();
        assert_eq!((got.allow_count, got.block_count, got.sealed_lists.as_str()), (2, 1, "AQ=="));

        put_gate(&http, &api, "tok_1", &lists(), "SEALED").await.unwrap();
        delete_gate(&http, &api, "tok_1").await.unwrap();
        delete_gate(&http, &api, "ungated").await.unwrap();

        let seen = seen.lock().unwrap().clone();
        let put = seen.iter().find(|s| s.method == "PUT").unwrap();
        assert_eq!(put.path, "/v1/shares/tok_1/gate");
        assert_eq!(put.auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&put.body).unwrap(),
            serde_json::json!({ "allow": ["alice@acme.com", "acme.com"], "block": ["mallory@acme.com"], "sealed_lists": "SEALED" })
        );
        assert!(seen.iter().any(|s| s.method == "DELETE" && s.path == "/v1/shares/tok_1/gate"));
    }

    #[test]
    fn the_gate_crosses_ipc_in_camel_case() {
        let json = serde_json::to_value(gate_on(
            &WireGate {
                allow_count: 2,
                block_count: 1,
                sealed_lists: String::new(),
            },
            Some(lists()),
            Some(true),
        ))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "offered": true, "on": true, "allowCount": 2, "blockCount": 1, "inPlan": true,
                "lists": { "allow": ["alice@acme.com", "acme.com"], "block": ["mallory@acme.com"] }
            })
        );
        assert_eq!(
            serde_json::to_value(LinkGate::default()).unwrap(),
            serde_json::json!({ "offered": false, "on": false, "allowCount": 0, "blockCount": 0, "lists": null, "inPlan": null })
        );
    }
}

//! Static regression guards for the block-subscription reconnect backoff.
//!
//! The backoff schedule and the healthy-session predicate are pinned by the
//! unit tests in `src/blockchain/subscription.rs`. What those cannot see is
//! whether the reconnect loop still APPLIES the reset: the loop lives inside a
//! `tokio::spawn` holding a real `AppHandle`, so it is not reachable from a
//! unit test. A refactor could drop the reset and every unit test would stay
//! green while the counter silently resumed its old monotonic climb — the bug
//! itself (nine benign sleep/wake disconnects escalating the delay 5s -> 60s
//! over one session) was invisible for exactly that reason.
//!
//! Same pattern as `tests/keep_awake_wiring.rs`.

/// Extract the brace-matched body of the function whose signature contains
/// `sig` — more precise than a whole-file substring match, which would pass
/// if the call lived in an unrelated helper.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("`{sig}` declaration present"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[body_start..=body_start + i];
                }
            }
            _ => {}
        }
    }
    panic!("`{sig}` body never closes");
}

fn subscription_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/blockchain/subscription.rs")).expect("read subscription.rs")
}

/// The reconnect loop must consult the healthy-session predicate and zero the
/// counter, otherwise a disconnect that ends hours of healthy streaming is
/// indistinguishable from one more failure against a dead endpoint.
#[test]
fn reconnect_loop_resets_backoff_after_a_healthy_session() {
    let src = subscription_src();
    let body = fn_body(&src, "pub async fn start_block_subscription(");
    assert!(
        body.contains("session_proves_endpoint_healthy"),
        "the reconnect loop must consult the healthy-session predicate",
    );
    assert!(
        body.contains("consecutive_failures = 0"),
        "a healthy session must zero `consecutive_failures`, not merely be observed",
    );
}

/// The predicate is only honest if the loop actually measures the session. A
/// reset gated on a counter nothing increments, or on a duration nothing
/// samples, would degrade to "always reset" or "never reset".
#[test]
fn reconnect_loop_measures_the_session_it_judges() {
    let src = subscription_src();
    let body = fn_body(&src, "pub async fn start_block_subscription(");
    assert!(
        body.contains("blocks_received") && body.contains("monotonic_now_ms()"),
        "the loop must sample both inputs (blocks delivered, elapsed time) per attempt",
    );

    // The block counter is only meaningful if the stream loop bumps it.
    let sub_body = fn_body(&src, "async fn subscribe_blocks(");
    assert!(
        sub_body.contains("*blocks_received"),
        "subscribe_blocks must record blocks actually delivered",
    );
}

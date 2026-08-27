//! Static guards on the three release lanes.
//!
//! Both failures pinned here are SILENT: nothing errors, nothing is annotated,
//! and the build publishes. They surface only as "the update never arrived" or
//! "the beta build behaves like production", weeks later and far from the edit
//! that caused them. Neither is reachable from a unit test — one lives in a
//! workflow file, the other across three config files — so the files are read
//! directly.

use std::fs;

fn repo_file(relative: &str) -> String {
    let path = format!("{}/{relative}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {path}: {err}"))
}

/// The value `release_channel::parse_release_channel` matches for the beta lane.
///
/// Duplicated as a literal rather than imported: the point is to compare the
/// workflow against the parser, and importing the parser's own constant would
/// let a rename satisfy both sides at once.
const BETA_CHANNEL_VALUE: &str = "beta";

/// `tauri-beta.yml` must export the channel string the parser recognizes.
///
/// `parse_release_channel` fails safe — anything it does not recognize is
/// Production. That is the right direction for an unset value and the wrong one
/// for a typo here: `HIPPIUS_RELEASE_CHANNEL: betta` would produce a beta build
/// that reports itself as production, so its update checks would follow the
/// production manifest and the in-app switch would show the wrong channel. The
/// build succeeds and the release publishes either way.
#[test]
fn the_beta_workflow_exports_the_channel_the_parser_recognizes() {
    let workflow = repo_file("../.github/workflows/tauri-beta.yml");
    let expected = format!("HIPPIUS_RELEASE_CHANNEL: {BETA_CHANNEL_VALUE}");

    assert!(
        workflow.contains(&expected),
        "tauri-beta.yml must set `{expected}`; parse_release_channel treats any other value as \
         Production, so a typo silently ships a beta build that reports itself as production"
    );
}

/// The tag Rust checks and the tag the workflow writes must be the same one.
///
/// They are declared in two files with nothing connecting them. If they drift,
/// `publish-manifest` keeps succeeding, the release list looks healthy, and beta
/// builds check a URL nobody publishes to — so the lane silently stops updating.
/// Derived from the Rust constant rather than hardcoded, so the pin cannot be
/// satisfied by editing both sides to the same wrong value.
#[test]
fn the_beta_workflow_publishes_to_the_tag_rust_checks() {
    let manifest = tauri_project_lib::release_channel::ReleaseChannel::Beta
        .manifest_url()
        .expect("beta publishes a manifest");

    // ".../releases/download/<tag>/latest.json"
    let tag = manifest
        .rsplit_once("/latest.json")
        .and_then(|(head, _)| head.rsplit_once('/'))
        .map(|(_, tag)| tag)
        .expect("beta manifest URL ends in /<tag>/latest.json");

    // A tag equal to the branch name makes `git push origin beta` fail with
    // "src refspec beta matches more than one" for everyone, and `git checkout
    // beta` ambiguous — breaking the promotion flow the lane exists for.
    assert_ne!(tag, "beta", "the beta manifest tag must not collide with the `beta` branch name");

    let workflow = repo_file("../.github/workflows/tauri-beta.yml");
    assert!(
        workflow.contains(&format!("gh release upload {tag} --repo")),
        "tauri-beta.yml must upload latest.json to the `{tag}` release; Rust checks that tag and \
         nothing else connects the two"
    );
    assert!(
        workflow.contains(&format!("gh release create {tag} --repo")),
        "tauri-beta.yml must create the `{tag}` release on first run"
    );
}

/// The beta workflow must be able to read `STATE_EPOCH` out of the source.
///
/// It greps for `const STATE_EPOCH: u32 = <n>` and writes the value into
/// `latest.json`. Rename the constant or change its type and the grep finds
/// nothing — the workflow now fails loudly rather than omitting the key, but
/// only because the declaration shape is what it matches on. This pins that
/// shape from the other side, so the break is caught in CI on the PR that
/// causes it rather than on the next beta release.
///
/// An omitted key is not a loud failure downstream: every build reads a missing
/// epoch as "unknown" and PERMITS the switch, which silently disables the
/// downgrade guard.
#[test]
fn the_state_epoch_declaration_stays_greppable() {
    let source = repo_file("src/updates.rs");
    let declaration = source
        .lines()
        .find(|line| line.trim_start().starts_with("const STATE_EPOCH: u32 = "))
        .expect("updates.rs declares `const STATE_EPOCH: u32 = <n>;` — tauri-beta.yml greps for exactly this shape");

    let value = declaration
        .trim()
        .trim_start_matches("const STATE_EPOCH: u32 = ")
        .trim_end_matches(';')
        .trim();
    assert!(
        value.chars().all(|c| c.is_ascii_digit()) && !value.is_empty(),
        "STATE_EPOCH must be a bare integer literal; tauri-beta.yml greps the digits out of this line, \
         and an expression would make the manifest claim an epoch the code does not have"
    );

    let workflow = repo_file("../.github/workflows/tauri-beta.yml");
    assert!(
        workflow.contains("const STATE_EPOCH: u32 = "),
        "tauri-beta.yml must still parse STATE_EPOCH out of updates.rs to write it into latest.json"
    );
    assert!(
        workflow.contains(".stateEpoch = $epoch"),
        "tauri-beta.yml must write the epoch into latest.json; without it every build reads the beta \
         lane's epoch as unknown and permits the switch"
    );
}

/// Staging publishes no manifest, so it must not be handed a separate updater
/// key either.
///
/// The two used to travel together: staging received its own pubkey while
/// keeping the production endpoint, so every check fetched the production
/// manifest and failed signature verification — which the updater reports as
/// "no update available", not as a misconfiguration. Every lane now signs with
/// the one `TAURI_SIGNING_PRIVATE_KEY`.
#[test]
fn no_lane_patches_a_channel_specific_updater_key() {
    for lane in ["tauri-staging.yml", "tauri-beta.yml", "tauri-build.yml"] {
        let workflow = repo_file(&format!("../.github/workflows/{lane}"));

        assert!(
            !workflow.contains("TAURI_SIGNING_PRIVATE_KEY_STAGING"),
            "{lane} signs with a channel-specific key; every lane shares TAURI_SIGNING_PRIVATE_KEY \
             so that a build can verify any channel's manifest"
        );
        assert!(
            !workflow.contains("TAURI_UPDATER_PUBKEY_STAGING"),
            "{lane} patches a channel-specific pubkey into tauri.conf.json; that is the merge \
             hazard the one-key model removes"
        );
    }
}

/// A version bump must touch all three files together.
///
/// Every workflow derives its tag with `jq -r .version src-tauri/tauri.conf.json`,
/// so that file is canonical — but `Cargo.toml` feeds the binary's own reported
/// version and `package.json` the frontend's. When they disagree the build still
/// succeeds; it simply uploads into the PREVIOUS release instead of creating a
/// new one, or reports a version that does not match the tag it shipped under.
/// `CLAUDE.md` has required this agreement for some time and nothing enforced it.
///
/// `Info.plist` is deliberately absent: `bundle_metadata_pin.rs` asserts the
/// opposite for that file, which must NOT carry a version.
#[test]
fn the_three_version_files_agree() {
    let tauri_conf = repo_file("tauri.conf.json");
    let canonical: String = serde_json::from_str::<serde_json::Value>(&tauri_conf)
        .expect("tauri.conf.json is valid JSON")
        .get("version")
        .and_then(|value| value.as_str())
        .expect("tauri.conf.json declares a version")
        .to_string();

    let package_json = repo_file("../package.json");
    let package_version = serde_json::from_str::<serde_json::Value>(&package_json)
        .expect("package.json is valid JSON")
        .get("version")
        .and_then(|value| value.as_str())
        .expect("package.json declares a version")
        .to_string();

    // The first `version = "…"` after `[package]` — the workspace manifest has
    // one package table and dependency versions all sit under other tables.
    let cargo_toml = repo_file("Cargo.toml");
    let package_table = cargo_toml.split("[package]").nth(1).expect("Cargo.toml has a [package] table");
    let cargo_version = package_table
        .lines()
        .find_map(|line| line.trim().strip_prefix("version = "))
        .map(|value| value.trim().trim_matches('"').to_string())
        .expect("Cargo.toml [package] declares a version");

    assert_eq!(
        cargo_version, canonical,
        "src-tauri/Cargo.toml is on {cargo_version} but tauri.conf.json (which every workflow reads \
         for its tag) is on {canonical}"
    );
    assert_eq!(
        package_version, canonical,
        "package.json is on {package_version} but tauri.conf.json (which every workflow reads for \
         its tag) is on {canonical}"
    );
}

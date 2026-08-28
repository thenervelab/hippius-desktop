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

/// Every beta platform job must publish a DRAFT, and something must un-draft it.
///
/// The three jobs have no `needs:` on each other and each upserts the same tag
/// with `overwrite: true`, so the release's properties are whatever the job that
/// arrived FIRST asked for. One job setting `releaseDraft: true` while the others
/// say `false` therefore does nothing — which is exactly what shipped: the
/// `v0.5.0-beta.3` run published a release carrying macOS and Linux assets and no
/// Windows installer, because the Linux job finished first.
///
/// `tauri-build.yml` cannot hit this because it builds the three platforms as a
/// MATRIX, so there is one setting rather than three. This lane inherited
/// staging's three-independent-jobs shape, where every release property is
/// raceable — the same class the `releaseName` comment there already warns about.
///
/// Asserts on the count as well as the values: a fourth job added without the
/// setting would otherwise pass while reintroducing the race.
#[test]
fn every_beta_job_publishes_a_draft() {
    let workflow = repo_file("../.github/workflows/tauri-beta.yml");

    let settings: Vec<&str> = workflow
        .lines()
        .filter_map(|line| line.trim().strip_prefix("releaseDraft:"))
        .map(str::trim)
        .collect();

    assert_eq!(
        settings.len(),
        3,
        "expected one releaseDraft per platform job in tauri-beta.yml, found {}: {settings:?}",
        settings.len()
    );
    assert!(
        settings.iter().all(|value| *value == "true"),
        "every beta platform job must publish a draft, found {settings:?}; the jobs race to create \
         the release and the first one's setting wins, so a single `false` publishes a half-built \
         release with whatever assets happen to exist at that moment"
    );

    // A draft nothing un-drafts is worse than no draft at all — the release
    // would never become visible.
    assert!(
        workflow.contains("--draft=false"),
        "publish-manifest must flip the release out of draft once the manifest is correct; \
         without it every beta release stays invisible"
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

/// The committed pubkey must stay the one key every lane signs with.
///
/// Its sibling above only forbids a WORKFLOW from patching the key, which is
/// the mechanism that has since been deleted. The committed value was never
/// pinned, and that is the half that shipped: a pubkey swapped in `tauri.conf.json`
/// for internal preview signing stayed on the lane for three months, so those
/// builds verify with a key nothing is signed with and fail every update with
/// minisign's "The signature was created with a different key than the one
/// provided".
///
/// This is unrecoverable in the field rather than merely broken — the pubkey is
/// compiled into the binary, so no re-signing, manifest edit, or later release
/// can reach an install that already has the wrong one; a manual reinstall is
/// the only remedy. That asymmetry is why the value is pinned and not just
/// reviewed. It also covers all three lanes at once: they share this one file,
/// so a branch that edits the key fails its own CI before it can merge.
///
/// A literal, because nothing in-repo can derive it — the matching private key
/// is the `TAURI_SIGNING_PRIVATE_KEY` secret. Rotating the key therefore means
/// deliberately editing this pin, which is the review the change needs.
#[test]
fn the_committed_updater_pubkey_is_the_one_every_lane_signs_with() {
    // minisign public key E411FB37072F234F, base64 of the whole `.pub` file.
    // Split only to stay inside the line width; the halves concatenate verbatim.
    const UPDATER_PUBKEY: &str = concat!(
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU0MTFGQjM3MDcyRjIzNEYK",
        "UldSUEl5OEhOL3NSNUdYMmxpUG1WUWtiTWd1TDRjMkt6aXBveFdmYmx3TjJTd01UUW1IMmJGZUgK",
    );

    let conf: serde_json::Value = serde_json::from_str(&repo_file("tauri.conf.json")).expect("tauri.conf.json is valid JSON");

    let pubkey = conf["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("tauri.conf.json declares plugins.updater.pubkey");

    assert_eq!(
        pubkey, UPDATER_PUBKEY,
        "tauri.conf.json carries an updater pubkey that is not the one every lane signs with. \
         Shipping it strands every install it reaches — the key is compiled in, so those builds \
         can never auto-update again. Change this pin only when rotating TAURI_SIGNING_PRIVATE_KEY."
    );
}

/// The app's macOS floor must not drop below the Finder extension's.
///
/// Three files declare it and nothing connected them. The floor was Tauri's
/// default `10.13.0` while the appex targeted `11.0` and
/// `enablement.rs::is_extension_enabled` sent `isExtensionEnabled` — a 10.14+
/// selector — with no availability check, on the strength of a comment claiming
/// the minimum was "well above that". On 10.13 that is an unrecognized selector
/// and the process aborts.
///
/// Raising the floor is what makes the unguarded send correct, so this pins the
/// premise rather than the conclusion: lower the app's floor again and this
/// fails, instead of a crash reaching a user on an old Mac.
#[test]
fn the_app_floor_is_at_least_the_extension_floor() {
    fn parts(version: &str) -> Vec<u32> {
        version.split('.').map(|part| part.parse().unwrap_or(0)).collect()
    }

    let project = repo_file("../macos/HippiusFinder/project.yml");
    let appex_floor = project
        .lines()
        .skip_while(|line| !line.contains("deploymentTarget:"))
        .find_map(|line| line.trim().strip_prefix("macOS:"))
        .map(|value| value.trim().trim_matches('"').to_string())
        .expect("project.yml declares deploymentTarget.macOS");

    let plist = repo_file("Info.plist");
    let plist_floor = plist
        .lines()
        .skip_while(|line| !line.contains("LSMinimumSystemVersion"))
        .find_map(|line| line.trim().strip_prefix("<string>"))
        .map(|value| value.trim_end_matches("</string>").to_string())
        .expect("Info.plist declares LSMinimumSystemVersion");

    let conf: serde_json::Value = serde_json::from_str(&repo_file("tauri.conf.json")).expect("tauri.conf.json is valid JSON");
    let conf_floor = conf
        .pointer("/bundle/macOS/minimumSystemVersion")
        .and_then(|value| value.as_str())
        .expect("tauri.conf.json declares bundle.macOS.minimumSystemVersion");

    assert_eq!(
        plist_floor, conf_floor,
        "Info.plist says {plist_floor} but tauri.conf.json says {conf_floor}; Info.plist is merged \
         OVER Tauri's generated plist, so the two disagreeing means the shipped value is whichever \
         file happens to win"
    );
    assert!(
        parts(&plist_floor) >= parts(&appex_floor),
        "the app's macOS floor ({plist_floor}) is below the Finder extension's ({appex_floor}); \
         below the extension's floor it cannot load, and below 10.14 the unguarded \
         `isExtensionEnabled` send in enablement.rs aborts on an unrecognized selector"
    );
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

/// Every lane that writes a macOS entry into `latest.json` must write the
/// `-app` keys too, not only the bare `darwin-<arch>` ones.
///
/// `tauri-plugin-updater` resolves `[{os}-{arch}-{installer}, {os}-{arch}]` in
/// that order (`updater.rs::get_urls`), and `installer_for_bundle_type` maps a
/// macOS `.app` — which is what a DMG install reports as well — to `app`. So
/// `darwin-<arch>-app` is the key macOS actually reads, and `tauri-action`
/// pre-populates it with ITS artifact: the `--bundles app` build produced
/// BEFORE the finalize step embeds the Finder extension and notarizes.
///
/// Patching only the bare keys therefore fixes a key nothing reads. Both lanes
/// shipped that way: the DMG was correct, every macOS auto-update replaced the
/// installed app with an extension-less, unstapled one, and no job failed —
/// the manifest was valid, the signature verified, and the update installed.
#[test]
fn the_macos_manifest_patch_covers_the_key_the_updater_actually_reads() {
    // Only lanes that publish a manifest. Staging's `manifest_url()` is `None`,
    // so it writes no macOS entry and has nothing to get wrong here.
    for lane in ["tauri-build.yml", "tauri-beta.yml"] {
        let workflow = repo_file(&format!("../.github/workflows/{lane}"));

        for arch in ["aarch64", "x86_64"] {
            let bare = format!("darwin-{arch}");
            let app = format!("darwin-{arch}-app");

            assert!(
                workflow.contains(&format!("\"{bare}\"")),
                "{lane} no longer writes a {bare} entry into latest.json"
            );
            assert!(
                workflow.contains(&format!("\"{app}\"")),
                "{lane} writes {bare} but not {app}. The updater reads {app} FIRST, so the \
                 correction never reaches macOS and auto-updates serve tauri-action's \
                 pre-finalize build — no Finder extension, never notarized or stapled."
            );
        }
    }
}

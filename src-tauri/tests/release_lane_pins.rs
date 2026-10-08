//! Static guards on the three release lanes.
//!
//! Every failure pinned here is SILENT: nothing errors, nothing is annotated,
//! and the build publishes. They surface only as "the update never arrived",
//! "the beta build behaves like production", or "the Finder extension
//! disappeared" — weeks later and far from the edit that caused them. None is
//! reachable from a unit test, since they live in workflow files and across
//! config files, so those files are read directly.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;

fn repo_file(relative: &str) -> String {
    let path = format!("{}/{relative}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {path}: {err}"))
}

/// The artifact `tauri-action` uploads before the finalize step embeds the
/// Finder extension and notarizes. A different FILENAME from the finalized
/// tarball, so the finalize step's `--clobber` cannot replace it.
const PRE_FINALIZE_ARTIFACT: &str = "Hippius_universal.app.tar.gz";

/// One workflow job, reduced to what these pins reason about.
struct Job {
    /// Jobs this one waits for, however `needs:` was spelled.
    needs: Vec<String>,
    /// Every `run:` script in the job, concatenated.
    script: String,
}

/// Parse a workflow into its job graph.
///
/// Structural rather than textual on purpose: the guarantee being pinned is
/// "publication happens downstream of verification", which is a property of the
/// `needs:` edges. A grep for both strings in one file would keep passing after
/// someone moved the verify job off the publish job's dependency chain — the
/// exact edit that would reopen the hole.
fn workflow_jobs(lane: &str) -> HashMap<String, Job> {
    let text = repo_file(&format!("../.github/workflows/{lane}"));
    let document: serde_yaml::Value = serde_yaml::from_str(&text).unwrap_or_else(|err| panic!("{lane} is not valid YAML: {err}"));

    let jobs = document
        .get("jobs")
        .and_then(serde_yaml::Value::as_mapping)
        .unwrap_or_else(|| panic!("{lane} declares no jobs"));

    jobs.iter()
        .filter_map(|(name, body)| {
            let name = name.as_str()?.to_string();

            // `needs:` is either a single job name or a list of them.
            let needs = match body.get("needs") {
                Some(serde_yaml::Value::String(one)) => vec![one.clone()],
                Some(serde_yaml::Value::Sequence(many)) => many.iter().filter_map(|value| value.as_str().map(str::to_string)).collect(),
                _ => Vec::new(),
            };

            let script = body
                .get("steps")
                .and_then(serde_yaml::Value::as_sequence)
                .map(|steps| {
                    steps
                        .iter()
                        .filter_map(|step| step.get("run").and_then(serde_yaml::Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();

            Some((name, Job { needs, script }))
        })
        .collect()
}

/// The single job whose script contains `needle`, panicking unless there is
/// exactly one — two would make "which job publishes" ambiguous, and the pin
/// would then be guarding the wrong one.
fn only_job_running(jobs: &HashMap<String, Job>, needle: &str, lane: &str) -> String {
    let mut found: Vec<&String> = jobs.iter().filter(|(_, job)| job.script.contains(needle)).map(|(name, _)| name).collect();
    found.sort();

    assert_eq!(found.len(), 1, "expected exactly one job in {lane} running `{needle}`, found {found:?}");
    found[0].clone()
}

/// Whether any job `start` transitively depends on satisfies `predicate`.
fn dependency_satisfies(jobs: &HashMap<String, Job>, start: &str, predicate: impl Fn(&Job) -> bool) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::from([start.to_string()]);

    while let Some(name) = queue.pop_front() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some(job) = jobs.get(&name) else { continue };
        if predicate(job) {
            return true;
        }
        queue.extend(job.needs.iter().cloned());
    }
    false
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

/// Every lane must delete `tauri-action`'s pre-finalize artifact.
///
/// The macOS release is built `--bundles app` so the Finder extension can be
/// embedded afterwards, and `tauri-action` uploads THAT build — no
/// `HippiusFinder.appex`, never notarized, never stapled — under a name the
/// finalize step's `--clobber` does not cover. It then sits on the release page
/// beside `Hippius_universal.dmg`, reading as its sibling, while the file a user
/// actually wants is the differently-named `Hippius.app.tar.gz`.
///
/// Nothing references it once the manifest is corrected, so no job fails and no
/// updater is affected. The cost lands entirely on whoever downloads by hand and
/// installs a build with no "Share with Hippius" in it.
#[test]
fn every_lane_deletes_the_pre_finalize_artifact() {
    let sig = format!("{PRE_FINALIZE_ARTIFACT}.sig");

    for lane in ["tauri-staging.yml", "tauri-beta.yml", "tauri-build.yml"] {
        let jobs = workflow_jobs(lane);

        // Bound to the deleting JOB, and to a non-comment line inside it. A
        // file-wide substring pair passes while the two strings sit in
        // unrelated jobs, and the artifact name appears in the shell comment
        // that explains the delete — so the obvious spelling of this pin keeps
        // passing after the loop it guards has been removed.
        let deleter = only_job_running(&jobs, "gh release delete-asset", lane);
        let script = &jobs[&deleter].script;

        for asset in [PRE_FINALIZE_ARTIFACT, sig.as_str()] {
            let named_in_code = script
                .lines()
                .map(str::trim)
                .filter(|line| !line.starts_with('#'))
                .any(|line| line.contains(asset));

            assert!(
                named_in_code,
                "{lane}'s {deleter} job deletes release assets but never names {asset} in an \
                 executed line, so tauri-action's pre-finalize build stays attached to the release"
            );
        }
    }
}

/// A lane must not publish a release it has not opened and checked.
///
/// The failures the verification catches are invisible from the build log:
/// `finalize-macos-release.sh` reports success whether or not the extension made
/// it into the bundle, a manifest naming the wrong tarball is valid JSON with a
/// valid signature, and the resulting update installs cleanly. v0.5.0 shipped a
/// macOS auto-update carrying no Finder extension and no notarization staple and
/// every job was green.
///
/// So the guarantee is an ORDERING one — draft, verify, only then publish — and
/// it is pinned on the `needs:` graph rather than on the presence of the strings,
/// because moving the verify job off the publish job's dependency chain would
/// leave both strings in the file and reopen the hole.
#[test]
fn no_lane_publishes_before_verifying_the_artifacts() {
    // Staging publishes on the spot rather than as a draft and is covered by
    // `staging_verifies_before_it_uploads` instead.
    for lane in ["tauri-build.yml", "tauri-beta.yml"] {
        let jobs = workflow_jobs(lane);
        let publisher = only_job_running(&jobs, "--draft=false", lane);

        assert!(
            dependency_satisfies(&jobs, &publisher, |job| { job.script.contains("macos/verify-macos-artifacts.sh") }),
            "in {lane} the job that publishes the release ({publisher}) does not depend on any job \
             running macos/verify-macos-artifacts.sh, so a build with no Finder extension or no \
             notarization staple would publish exactly as v0.5.0 did"
        );
        assert!(
            dependency_satisfies(&jobs, &publisher, |job| { job.script.contains("scripts/verify-release-manifest.sh") }),
            "in {lane} the job that publishes the release ({publisher}) does not depend on any job \
             running scripts/verify-release-manifest.sh, so latest.json could point macOS at an \
             asset this release does not carry"
        );
    }
}

/// Staging has no draft to hold a bad build back, so it must verify BEFORE it
/// uploads.
///
/// The other two lanes build a draft and gate publication on a separate job.
/// Staging's platform jobs publish immediately (`releaseDraft: false`), so by
/// the time a separate job could run, testers can already have the build. The
/// only point of control is ahead of the upload, in the same script.
///
/// A staging DMG that looks complete and is not costs testers days — the same
/// reasoning that makes the lane stamp ` - NO FINDER EXTENSION OR RECORDING` onto the release
/// name when it builds without notarization creds.
#[test]
fn staging_verifies_before_it_uploads() {
    let jobs = workflow_jobs("tauri-staging.yml");
    let job = jobs.get("publish-tauri-macos").expect("tauri-staging.yml has a publish-tauri-macos job");

    let verify = job
        .script
        .find("macos/verify-macos-artifacts.sh")
        .expect("tauri-staging.yml's macOS job must verify the finalized artifacts");
    let upload = job
        .script
        .find("gh release upload")
        .expect("tauri-staging.yml's macOS job uploads the finalized artifacts");

    assert!(
        verify < upload,
        "tauri-staging.yml verifies the macOS artifacts only AFTER uploading them; the lane \
         publishes on the spot, so the check has to run first or testers already have the build"
    );
}

/// The bare `linux-x86_64` key is the ONLY key a Linux build resolves.
/// plugin-updater appends the installer segment (`-deb`) only when
/// `bundle_type()` is `Some`, and the marker it reads is not patched into the
/// shipped `.deb`, so it is `None` and `linux-x86_64-deb` is never searched.
/// Deleting the bare key does not stop an install — it makes every Linux
/// update CHECK fail with `TargetsNotFound`. Refusing the install belongs in
/// the app (`updates.rs::refuse_if_privileged_package`), not in the manifest.
#[test]
fn no_lane_deletes_the_bare_linux_updater_key() {
    for lane in ["tauri-build.yml", "tauri-beta.yml", "tauri-staging.yml"] {
        let workflow = repo_file(&format!("../.github/workflows/{lane}"));
        assert!(
            !workflow.contains(r#"del(.platforms["linux-x86_64"])"#),
            "{lane} deletes the bare linux-x86_64 key; that is the only key Linux reads, so \
             every Linux update check would report the channel as unreachable"
        );
    }
}

/// The publish-time verifier must catch the same deletion in a hand-edited
/// `latest.json`, which no workflow pin can see.
#[test]
fn verify_manifest_requires_the_bare_linux_key() {
    let script = repo_file("../scripts/verify-release-manifest.sh");
    assert!(
        script.contains(r#".platforms["linux-x86_64"]"#) && script.contains("TargetsNotFound"),
        "verify-release-manifest.sh must fail when linux-x86_64 is missing"
    );
}

/// Linux and Windows ship on every lane. "macOS Only" in the release body
/// becomes latest.json `notes` (tauri-action copies releaseBody), so the
/// in-app dialog told Linux QA the build was Mac-only while they were on it.
#[test]
fn no_lane_claims_macos_only() {
    for lane in ["tauri-build.yml", "tauri-beta.yml", "tauri-staging.yml"] {
        let workflow = repo_file(&format!("../.github/workflows/{lane}"));
        for (i, line) in workflow.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                continue;
            }
            assert!(
                !trimmed.to_ascii_lowercase().contains("macos only"),
                "{lane}:{} still says macOS Only: {trimmed}",
                i + 1
            );
        }
    }
}

/// The frontend must read the SAME channel variable Rust does.
///
/// Two independent readers of one env var with nothing connecting them.
/// The frontend build runs inside `tauri build` (`beforeBuildCommand`), so
/// the workflow's single env line reaches both — but only while
/// `next.config.ts` forwards that exact name. Rename it on either side and
/// nothing fails: the bundle's `process.env.RELEASE_CHANNEL` is simply
/// undefined, `parseBuildChannel` falls safe to production, and every
/// channel-gated feature quietly stops appearing on the lane that was
/// supposed to show it. The build succeeds, the release publishes, and the
/// only symptom is a feature nobody can find.
///
/// Derived from `release_channel.rs` rather than hardcoded, so the pin
/// cannot be satisfied by editing both sides to the same wrong value.
#[test]
fn the_frontend_reads_the_same_channel_variable_rust_does() {
    let rust = repo_file("src/release_channel.rs");
    let declaration = rust
        .lines()
        .find(|line| line.contains("option_env!"))
        .expect("release_channel.rs reads the channel through option_env!");
    let var = declaration
        .split_once("option_env!(\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(name, _)| name)
        .expect("option_env! names a variable");

    let config = repo_file("../next.config.ts");
    let expected = format!("process.env.{var}");
    assert!(
        config.contains(&expected),
        "release_channel.rs reads {var}, but next.config.ts does not forward `{expected}` — \
         channel-gated frontend flags would silently fall back to production on every lane"
    );
    assert!(
        config.contains("RELEASE_CHANNEL:"),
        "next.config.ts must expose the channel to the bundle as RELEASE_CHANNEL, which is the \
         name app/lib/buildChannel.ts reads"
    );
}

/// Non-comment lines of a shell script, trimmed.
fn code_lines(script: &str) -> Vec<&str> {
    script
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

fn position_of(lines: &[&str], needle: &str) -> Option<usize> {
    lines.iter().position(|line| line.contains(needle))
}

/// The screen-recording helper is not a Tauri artifact: every macOS release
/// job must build it, universal, before finalizing.
///
/// A release app looks for `Contents/MacOS/HippiusCapture` and nowhere else,
/// and without it the app hides every Record action and lists no cameras or
/// microphones. Nothing errors and nothing is annotated; testers only notice
/// that "recording is missing". The build step runs before the long Tauri
/// build so a Swift error fails the job in seconds; the finalize script
/// builds it again (cached) and embeds that.
#[test]
fn every_macos_release_job_builds_the_recording_helper() {
    for lane in ["tauri-staging.yml", "tauri-beta.yml", "tauri-build.yml"] {
        let jobs = workflow_jobs(lane);
        let finalizer = only_job_running(&jobs, "macos/finalize-macos-release.sh", lane);
        let lines = code_lines(&jobs[&finalizer].script);

        let build = position_of(&lines, "macos/build-capture-helper.sh --universal").unwrap_or_else(|| {
            panic!(
                "{lane}'s {finalizer} job never runs `macos/build-capture-helper.sh --universal`, so its \
                 macOS build ships with no screen recording"
            )
        });
        let finalize = position_of(&lines, "macos/finalize-macos-release.sh").expect("the finalize step runs");
        assert!(
            build < finalize,
            "{lane} builds the recording helper only after finalizing, when nothing embeds it any more"
        );
    }
}

/// The finalize script embeds and signs the helper BEFORE the step that
/// re-signs the app last; embedding it afterwards would break the app's seal
/// and fail notarization. Signing needs the hardened runtime, a secure
/// timestamp and the helper's own entitlements, of which `audio-input` is
/// the silent one: without it a signed build records a silent microphone.
#[test]
fn the_recording_helper_is_embedded_and_signed_before_the_app_is_sealed() {
    let finalize = repo_file("../macos/finalize-macos-release.sh");
    let lines = code_lines(&finalize);
    let built = position_of(&lines, "build-capture-helper.sh\" --universal").expect("finalize builds the universal helper");
    let embedded = position_of(&lines, "embed-capture-helper.sh").expect("finalize embeds the helper");
    let sealed = position_of(&lines, "embed-finder-extension.sh").expect("finalize embeds the extension and re-signs the app");
    assert!(built < embedded && embedded < sealed, "helper: build, embed, then the app is re-signed");

    let embed = repo_file("../macos/embed-capture-helper.sh");
    assert!(embed.contains("entitlements=\"${script_dir}/CaptureHelper.entitlements\""));
    let signing = embed.split("codesign --force").nth(1).expect("embed-capture-helper.sh signs the helper");
    for flag in ["--options runtime", "--timestamp", "--entitlements \"${entitlements}\""] {
        assert!(signing.contains(flag), "the release signing of the helper lacks {flag}");
    }
    // The local build's opt-out of the secure timestamp must never reach a
    // release: a helper without one fails notarization.
    for path in [
        "../macos/finalize-macos-release.sh",
        "../.github/workflows/tauri-build.yml",
        "../.github/workflows/tauri-beta.yml",
        "../.github/workflows/tauri-staging.yml",
    ] {
        assert!(
            !repo_file(path).contains("HIPPIUS_CODESIGN_TIMESTAMP"),
            "{path} must not skip the helper's secure timestamp"
        );
    }

    let entitlements = repo_file("../macos/CaptureHelper.entitlements");
    let squashed: String = entitlements.split_whitespace().collect();
    assert!(
        squashed.contains("<key>com.apple.security.device.audio-input</key><true/>"),
        "the helper must be allowed the microphone"
    );
    assert!(
        !entitlements.contains("allow-jit"),
        "the helper runs no JIT; keep its entitlements minimal"
    );
}

/// `verify-macos-artifacts.sh` must open the helper in both artifacts, or a
/// release without recording publishes as quietly as v0.5.0 did without its
/// Finder extension.
#[test]
fn the_artifact_check_fails_without_the_recording_helper() {
    let verify = repo_file("../macos/verify-macos-artifacts.sh");
    let bundle_checks = verify
        .split("check_app_bundle() {")
        .nth(1)
        .and_then(|rest| rest.split("\n}").next())
        .expect("verify-macos-artifacts.sh has check_app_bundle");
    assert!(
        code_lines(bundle_checks).iter().any(|line| line.starts_with("check_capture_helper ")),
        "check_app_bundle no longer checks the recording helper"
    );
    let helper_checks = verify
        .split("check_capture_helper() {")
        .nth(1)
        .and_then(|rest| rest.split("\n}").next())
        .expect("verify-macos-artifacts.sh defines check_capture_helper");
    for needle in [
        "Contents/MacOS/HippiusCapture",
        "check_universal",
        "com.apple.security.device.audio-input",
        "(runtime)",
        "Timestamp=",
    ] {
        assert!(helper_checks.contains(needle), "check_capture_helper no longer checks {needle}");
    }
}

/// A release build must not probe the CI checkout path `CARGO_MANIFEST_DIR`
/// bakes in; a stray file there would be executed. Only debug builds look in
/// the Swift package.
#[test]
fn a_release_build_looks_for_the_recording_helper_only_inside_the_app() {
    let recorder = repo_file("src/capture/recording/macos.rs");
    assert!(
        recorder.contains("#[cfg(not(debug_assertions))]\n    let dev_package: Option<PathBuf> = None;"),
        "helper_path must not look outside the app bundle in release builds"
    );
}

/// Per-platform capture readiness lives in `capture::rollout`, one floor per
/// (platform, feature). Production must enable exactly the rows marked
/// production: a staging-only row that leaked into a production build shows
/// a half-ready platform to every user, and nothing else would notice.
#[test]
fn production_enables_only_the_capture_rows_marked_production() {
    use tauri_project_lib::capture::rollout::{Feature, Platform, enabled, floor};
    use tauri_project_lib::release_channel::ReleaseChannel;

    for platform in Platform::ALL {
        for feature in Feature::ALL {
            let marked_production = floor(platform, feature) == Some(ReleaseChannel::Production);
            assert_eq!(
                enabled(ReleaseChannel::Production, platform, feature),
                marked_production,
                "{platform:?} {feature:?}: production must follow the row's floor"
            );
            let marked_beta_or_later = matches!(floor(platform, feature), Some(ReleaseChannel::Beta | ReleaseChannel::Production));
            assert_eq!(
                enabled(ReleaseChannel::Beta, platform, feature),
                marked_beta_or_later,
                "{platform:?} {feature:?}: beta must follow the row's floor"
            );
        }
    }
}

/// An unsigned Windows binary that records the screen and the microphone is
/// what SmartScreen and Defender look at hardest. Windows recording may reach
/// production only once the installer is signed (a certificate thumbprint or
/// a sign command in `tauri.conf.json`).
#[test]
fn windows_recording_reaches_production_only_with_a_signed_installer() {
    use tauri_project_lib::capture::rollout::{Feature, Platform, floor};
    use tauri_project_lib::release_channel::ReleaseChannel;

    let config: serde_json::Value = serde_json::from_str(&repo_file("tauri.conf.json")).expect("tauri.conf.json parses");
    let windows = &config["bundle"]["windows"];
    let signed = !windows["certificateThumbprint"].is_null() || windows.get("signCommand").is_some_and(|c| !c.is_null());
    if floor(Platform::Windows, Feature::Recording) == Some(ReleaseChannel::Production) {
        assert!(signed, "Windows recording is marked production but the Windows installer is not signed");
    }
}

/// Screen capture carries most of the app's `cfg(windows)` code, and only the
/// release workflow builds on Windows otherwise. The Windows lane must deny
/// warnings over every target, run the capture tests, and run for any PR
/// that touches capture, whatever its base.
#[test]
fn the_windows_lane_runs_clippy_and_the_capture_tests_for_capture_prs() {
    let jobs = workflow_jobs("ci.yml");
    let windows = jobs.get("rust-windows").expect("ci.yml has a rust-windows job");
    assert!(
        windows.script.contains("cargo clippy --all-targets -- -D warnings"),
        "rust-windows must run clippy over every target with warnings denied"
    );
    assert!(
        windows.script.contains("cargo test --lib \"capture::\""),
        "rust-windows must run the capture unit tests"
    );
    let ci = repo_file("../.github/workflows/ci.yml");
    assert!(
        ci.contains("needs.changes.outputs.capture == 'true'"),
        "rust-windows must run for PRs that touch src-tauri/src/capture/**"
    );
    assert!(
        ci.contains("grep -qE '^src-tauri/src/capture/'"),
        "the changes job must detect a capture change"
    );
}

/// Linux recording links GStreamer (gstreamer-rs), so every Linux build
/// needs its development files: a lane without them fails at `pkg-config`
/// only when it next builds, which for production is the release itself.
/// The recorder's encoders and parsers are the distro's plugins, which the
/// deb only RECOMMENDS: a minimal system still installs Hippius and is told
/// which packages to add (`codecsMissing`).
#[test]
fn every_linux_build_has_gstreamer_and_the_deb_recommends_its_plugins() {
    const DEV: [&str; 2] = ["libgstreamer1.0-dev", "libgstreamer-plugins-base1.0-dev"];
    let setup = repo_file("../.github/actions/rust-ci-setup/action.yml");
    for package in DEV {
        assert!(setup.contains(package), "rust-ci-setup must install {package}");
    }
    // The release lanes install from one script, which CI also runs on the
    // same ubuntu-22.04 image (`release-deps-linux`). On that image
    // libgstreamer1.0-dev needs libunwind-dev, which clashes with the
    // preinstalled libunwind-14-dev unless it is asked for by name first.
    let script = repo_file("../scripts/install-linux-release-deps.sh");
    for package in DEV {
        assert!(script.contains(package), "the Linux release script must install {package}");
    }
    let unwind = script
        .find("install -y libunwind-dev")
        .expect("the script installs libunwind-dev by name");
    assert!(script[unwind..].contains(DEV[0]), "libunwind-dev must be installed before GStreamer");
    for lane in ["tauri-staging.yml", "tauri-beta.yml", "tauri-build.yml"] {
        let text = repo_file(&format!("../.github/workflows/{lane}"));
        assert!(
            text.contains("bash scripts/install-linux-release-deps.sh"),
            "{lane}'s Linux leg must use the shared script"
        );
        assert!(!text.contains("libwebkit2gtk-4.1-dev"), "{lane} must not keep its own package list");
    }
    assert!(
        workflow_jobs("ci.yml")
            .get("release-deps-linux")
            .is_some_and(|job| job.script.contains("bash scripts/install-linux-release-deps.sh")),
        "CI must install the release packages on the release image"
    );
    let config: serde_json::Value = serde_json::from_str(&repo_file("tauri.conf.json")).expect("tauri.conf.json parses");
    let deb = &config["bundle"]["linux"]["deb"];
    let recommends: Vec<&str> = deb["recommends"]
        .as_array()
        .expect("deb recommends")
        .iter()
        .filter_map(|r| r.as_str())
        .collect();
    for plugin in [
        "gstreamer1.0-pipewire",
        "gstreamer1.0-plugins-base",
        "gstreamer1.0-plugins-good",
        "gstreamer1.0-plugins-bad",
        "gstreamer1.0-plugins-ugly",
        "gstreamer1.0-libav",
    ] {
        assert!(recommends.contains(&plugin), "the deb must recommend {plugin}");
    }
    let depends = deb["depends"].as_array().expect("deb depends");
    assert!(
        !depends.iter().any(|d| d.as_str().is_some_and(|d| d.contains("gstreamer"))),
        "GStreamer plugins are recommended, never required"
    );
}

/// Staging also builds an `.rpm`, so Fedora can be tested from an artifact
/// (the capture plan's Linux checklist); beta and production ship the
/// `.deb` alone. The rpm, like the deb, only RECOMMENDS the GStreamer
/// plugins and the portal, in Fedora's names.
#[test]
fn only_staging_builds_an_rpm_and_it_recommends_fedoras_plugins() {
    let staging = repo_file("../.github/workflows/tauri-staging.yml");
    assert!(staging.contains("args: '--bundles deb,rpm'"), "staging builds deb and rpm");
    for lane in ["tauri-beta.yml", "tauri-build.yml"] {
        let text = repo_file(&format!("../.github/workflows/{lane}"));
        assert!(!text.contains("rpm"), "{lane} must not build an rpm");
    }
    let config: serde_json::Value = serde_json::from_str(&repo_file("tauri.conf.json")).expect("tauri.conf.json parses");
    let rpm = &config["bundle"]["linux"]["rpm"];
    let recommends: Vec<&str> = rpm["recommends"]
        .as_array()
        .expect("rpm recommends")
        .iter()
        .filter_map(|r| r.as_str())
        .collect();
    for package in [
        "gstreamer1-plugins-good",
        "gstreamer1-plugin-openh264",
        "gstreamer1-plugins-bad-free",
        "gstreamer1-plugin-libav",
        "pipewire-gstreamer",
    ] {
        assert!(recommends.contains(&package), "the rpm must recommend {package}");
    }
    assert!(rpm.get("depends").is_none_or(|d| !d.to_string().contains("gstreamer")));
}

/// The Linux lane runs the recorder's real GStreamer writer (the ignored
/// self-tests), with the plugins it needs installed first.
#[test]
fn the_linux_lane_runs_the_recorder_against_real_gstreamer() {
    let jobs = workflow_jobs("ci.yml");
    let linux = jobs.get("rust-linux-test").expect("ci.yml has a rust-linux-test job");
    assert!(linux.script.contains("gstreamer1.0-plugins-ugly") && linux.script.contains("gstreamer1.0-libav"));
    assert!(linux.script.contains("cargo test --lib capture::recorder_child::linux -- --ignored"));
}

/// Each Rust lane runs clippy and the tests as two parallel jobs, and the
/// lane's own name (`rust-linux`, `rust-macos`) is what branch rules
/// require. That job must wait for both halves and run even when one fails
/// (`!cancelled()`): a required check that is SKIPPED counts as passed, so
/// without it a failing clippy or test half would merge green.
#[test]
fn each_required_rust_lane_waits_for_its_clippy_and_test_halves() {
    let jobs = workflow_jobs("ci.yml");
    let ci = repo_file("../.github/workflows/ci.yml");
    let document: serde_yaml::Value = serde_yaml::from_str(&ci).expect("ci.yml parses");
    for lane in ["rust-linux", "rust-macos"] {
        let clippy = format!("{lane}-clippy");
        let test = format!("{lane}-test");
        let gate = jobs.get(lane).unwrap_or_else(|| panic!("ci.yml has a {lane} job"));
        assert!(
            gate.needs.contains(&clippy) && gate.needs.contains(&test) && gate.needs.iter().any(|n| n == "changes"),
            "{lane} waits for the changes gate, {clippy} and {test}"
        );
        assert_eq!(
            document["jobs"][lane]["if"].as_str(),
            Some("${{ !cancelled() }}"),
            "{lane} must run when a half fails"
        );
        assert!(gate.script.contains("exit 1"), "{lane} fails when a half did not pass");
        assert!(
            jobs.get(&clippy)
                .unwrap_or_else(|| panic!("ci.yml has a {clippy} job"))
                .script
                .contains("cargo clippy --all-targets -- -D warnings"),
            "{clippy} runs clippy over every target with warnings denied"
        );
        let test_job = jobs.get(&test).unwrap_or_else(|| panic!("ci.yml has a {test} job"));
        assert!(
            test_job.script.lines().any(|line| line.trim() == "cargo test"),
            "{test} runs the whole test suite"
        );
        assert_eq!(
            document["jobs"][clippy.as_str()]["if"],
            document["jobs"][test.as_str()]["if"],
            "{clippy} and {test} run on exactly the same events"
        );
    }
}

/// Rust caches are saved only by a push to a lane branch. A PR's cache is
/// readable by that PR alone, yet it counts against the repo's 10 GB cap and
/// evicted the lanes' caches, which left every later PR cold.
#[test]
fn rust_caches_are_saved_only_from_lane_pushes() {
    const LANE_PUSH: &str =
        "github.event_name == 'push' && (github.ref == 'refs/heads/staging' || github.ref == 'refs/heads/beta' || github.ref == 'refs/heads/main')";
    let setup = repo_file("../.github/actions/rust-ci-setup/action.yml");
    assert!(
        setup.contains(&format!("save-if: ${{{{ inputs.save-cache == 'true' && {LANE_PUSH} }}}}")),
        "rust-ci-setup saves only from a lane push"
    );
    let ci = repo_file("../.github/workflows/ci.yml");
    let document: serde_yaml::Value = serde_yaml::from_str(&ci).expect("ci.yml parses");
    for (name, body) in document["jobs"].as_mapping().expect("ci.yml jobs") {
        for step in body["steps"].as_sequence().into_iter().flatten() {
            if !step["uses"].as_str().is_some_and(|uses| uses.starts_with("swatinem/rust-cache@")) {
                continue;
            }
            let save_if = step["with"]["save-if"].as_str().unwrap_or_default();
            assert!(
                save_if == "false" || save_if == format!("${{{{ {LANE_PUSH} }}}}"),
                "{name:?}'s rust-cache must save only from a lane push, or never: {save_if:?}"
            );
        }
    }
}

/// The capture runtime jobs run the BUILT recorder child on real Windows and
/// Linux runners through the script that fails on "0 tests executed", only
/// for PRs that can change the child, and never on an unrelated PR (a job
/// that is skipped there must not be one anything waits on). Each failure
/// here is silent: a dropped `--ignored` or a lost gate keeps CI green while
/// the runtime evidence quietly stops.
#[test]
fn the_capture_runtime_jobs_run_the_built_recorder_for_capture_prs_only() {
    let jobs = workflow_jobs("ci.yml");
    let ci = repo_file("../.github/workflows/ci.yml");
    let document: serde_yaml::Value = serde_yaml::from_str(&ci).expect("ci.yml parses");
    for name in ["capture-runtime-windows", "capture-runtime-linux"] {
        let job = jobs.get(name).unwrap_or_else(|| panic!("ci.yml has a {name} job"));
        assert!(job.needs.iter().any(|n| n == "changes"), "{name} waits for the changes gate");
        assert!(
            job.script.contains("cargo test --test capture_recorder_runtime --no-run") && job.script.contains("scripts/capture-runtime-check.sh"),
            "{name} builds the app binary and runs the runtime checks through the script"
        );
        let body = &document["jobs"][name];
        assert_eq!(
            body["if"].as_str(),
            Some("github.event_name == 'pull_request' && needs.changes.outputs.capture_runtime == 'true'"),
            "{name} runs only for PRs that touch what the recorder child is built from"
        );
        let env_of = |key: &str| {
            body["steps"]
                .as_sequence()
                .into_iter()
                .flatten()
                .filter_map(|step| step["env"][key].as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            env_of("HIPPIUS_CAPTURE_RUNTIME_REQUIRE"),
            vec!["1"],
            "{name} turns a missing setup into a failure"
        );
        assert_eq!(
            env_of("CAPTURE_RUNTIME_MIN_TESTS"),
            vec!["8"],
            "{name} expects every runtime test to execute"
        );
    }
    let linux = jobs.get("capture-runtime-linux").expect("linux runtime job");
    assert!(linux.script.contains("scripts/with-xvfb.sh") && linux.script.contains("module-null-sink"));
    assert!(
        ci.contains("echo \"capture_runtime=true\" >> \"$GITHUB_OUTPUT\""),
        "the changes job sets the gate"
    );
    let script = repo_file("../scripts/capture-runtime-check.sh");
    assert!(script.contains("--ignored") && script.contains("CAPTURE_RUNTIME_MIN_TESTS") && script.contains("RUNTIME-SKIP:"));
    // The test file's count: every test in it is #[ignore]d, and the jobs
    // expect all of them to run.
    let tests = repo_file("tests/capture_recorder_runtime.rs");
    assert_eq!(
        tests.matches("#[test]").count(),
        8,
        "update CAPTURE_RUNTIME_MIN_TESTS in ci.yml with the test count"
    );
    assert_eq!(
        tests.matches("#[ignore = \"").count(),
        8,
        "every runtime check is #[ignore]d, so plain `cargo test` stays hermetic"
    );
}

/// A hung step burns GitHub's six-hour default before anything fails, and the
/// PR shows red half a day later with no error in the log. Every CI job names
/// its own limit, sized well above its slowest cold run.
#[test]
fn every_ci_job_has_a_time_limit() {
    let ci = repo_file("../.github/workflows/ci.yml");
    let document: serde_yaml::Value = serde_yaml::from_str(&ci).expect("ci.yml parses");
    let jobs = document["jobs"].as_mapping().expect("ci.yml has jobs");
    for (name, job) in jobs {
        let name = name.as_str().unwrap_or_default();
        let limit = job["timeout-minutes"].as_u64();
        assert!(
            limit.is_some_and(|minutes| minutes <= 120),
            "ci.yml job {name} needs a timeout-minutes of at most 120"
        );
    }
}

/// A mirror that accepts the connection and then stops sending holds a bare
/// `apt-get` until the job is cancelled; apt's own timeouts do not catch it.
/// Every CI and release apt call goes through the wrapper that bounds each
/// attempt with `timeout` and retries.
#[test]
fn every_apt_call_goes_through_the_retry_wrapper() {
    let wrapper = repo_file("../scripts/apt-get-retry.sh");
    assert!(wrapper.contains("timeout \"$LIMIT\" apt-get"), "each attempt is bounded");
    let mut files = vec![
        "../.github/actions/rust-ci-setup/action.yml".to_string(),
        "../scripts/install-linux-release-deps.sh".to_string(),
    ];
    for entry in fs::read_dir(format!("{}/../.github/workflows", env!("CARGO_MANIFEST_DIR"))).expect("workflows dir") {
        let name = entry.expect("workflow entry").file_name().into_string().expect("utf-8 name");
        files.push(format!("../.github/workflows/{name}"));
    }
    for file in files {
        let text = repo_file(&file);
        for line in code_lines(&text) {
            assert!(
                !line.contains("apt-get ") || line.contains("apt-get-retry.sh"),
                "{file} calls apt-get directly: {line}"
            );
            // Steps run from different directories (several from
            // `src-tauri/`), so a workflow names the wrapper from the
            // workspace root, never relative to wherever the step runs.
            if file.contains(".github/") && line.contains("apt-get-retry.sh") {
                assert!(
                    line.contains("bash \"$GITHUB_WORKSPACE/scripts/apt-get-retry.sh\""),
                    "{file} must call the wrapper from the workspace root: {line}"
                );
            }
        }
    }
}

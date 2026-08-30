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
/// reasoning that makes the lane stamp ` - NO FINDER EXTENSION` onto the release
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

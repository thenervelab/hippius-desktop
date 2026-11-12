//! Finding the bundled engine and checking what it can do on this machine.
//!
//! The engine is `hippius-ffmpeg` (`.exe` on Windows), an LGPL ffmpeg built
//! by `scripts/video-engine/build-ffmpeg.sh` and shipped beside the app's
//! own binary (`Contents/MacOS` on macOS, the install folder on Windows,
//! `/usr/bin` for the Linux packages): Tauri's `externalBin` puts it there.
//! A build without it previews exactly what it did before.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::sync::OnceCell;

use super::plan::{Encoder, Platform};
use super::probe::{MediaInfo, parse_probe};

/// The engine's file name.
#[must_use]
pub const fn binary_name() -> &'static str {
    if cfg!(windows) { "hippius-ffmpeg.exe" } else { "hippius-ffmpeg" }
}

/// Debug builds and tests may point at an engine elsewhere.
pub const OVERRIDE_ENV: &str = "HIPPIUS_VIDEO_ENGINE";

/// How long reading a file's header may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long one encoder self-test may take.
const ENCODER_TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A command for the engine: no stdin, killed when dropped, and on Windows
/// no console window flashing up.
#[must_use]
pub fn command(program: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        /// `CREATE_NO_WINDOW`
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Where the engine is, if this build has one.
#[must_use]
pub fn locate() -> Option<PathBuf> {
    if cfg!(debug_assertions)
        && let Some(path) = std::env::var_os(OVERRIDE_ENV).map(PathBuf::from)
    {
        return path.is_file().then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(binary_name());
    candidate.is_file().then_some(candidate)
}

/// The engine and the H.264 encoder that works on this machine, found once.
#[derive(Debug, Clone)]
pub struct Engine {
    pub path: PathBuf,
    /// `None`: no encoder passed its test, so only remuxes are possible.
    pub encoder: Option<Encoder>,
}

/// Finds the engine and tests its encoders on first use, once per launch.
#[derive(Debug, Default)]
pub struct EngineCell {
    cell: OnceCell<Option<Engine>>,
}

impl EngineCell {
    pub async fn get(&self) -> Option<Engine> {
        self.cell
            .get_or_init(|| async {
                let path = locate()?;
                let encoder = pick_encoder(&path, Platform::current()).await;
                tracing::info!(engine = %path.display(), encoder = ?encoder, "video engine ready");
                Some(Engine { path, encoder })
            })
            .await
            .clone()
    }
}

/// The first encoder for `platform` that encodes a tenth of a second of test
/// picture: a listed encoder can still fail at runtime (no GPU encoder, a
/// Windows N edition without Media Foundation).
pub async fn pick_encoder(engine: &Path, platform: Platform) -> Option<Encoder> {
    for &encoder in Encoder::candidates(platform) {
        if encoder_works(engine, encoder).await {
            return Some(encoder);
        }
        tracing::info!(encoder = encoder.name(), "video engine encoder unavailable");
    }
    None
}

async fn encoder_works(engine: &Path, encoder: Encoder) -> bool {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=25",
        "-t",
        "0.2",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    args.extend(encoder.args(500));
    args.extend(["-f".into(), "null".into(), "-".into()]);
    let run = command(engine).args(&args).stdout(Stdio::null()).stderr(Stdio::null()).status();
    matches!(tokio::time::timeout(ENCODER_TEST_TIMEOUT, run).await, Ok(Ok(status)) if status.success())
}

/// What `input` holds, from the engine's reading of its header. `None` when
/// the engine does not recognise it.
pub async fn probe(engine: &Path, input: &Path) -> Option<MediaInfo> {
    let run = command(engine)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(input)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    // Exits non-zero by design ("At least one output file must be specified").
    let output = tokio::time::timeout(PROBE_TIMEOUT, run).await.ok()?.ok()?;
    parse_probe(&String::from_utf8_lossy(&output.stderr))
}

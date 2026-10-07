//! Video playback for the file viewer on Linux: a loopback HTTP stream.
//!
//! **Why this exists.** WebKitGTK plays `<video>` through GStreamer, and the
//! element that fetches a media URL through WebKit's own loader
//! (`webkitwebsrc`) claims only `http`, `https` and `blob`. A video on Tauri's
//! `asset://` scheme therefore never reaches wry's custom-scheme handler:
//! GStreamer looks for a source element for `asset` itself, finds none, and
//! the player sits on a black frame. Images and fetches on the same scheme
//! work, which is what made it look like a codec problem. Upstream:
//! WebKit bug 146351 (open since 2015), tauri-apps/tauri#3725 (open), whose
//! maintainers point at a local HTTP server as the only way for large files.
//! A `blob:` URL would play, but only after reading the whole file into the
//! renderer, which a long recording cannot afford.
//!
//! So on Linux the viewer gets `http://127.0.0.1:<port>/v/<token>` from
//! [`video_playback_source`], served here with byte ranges, which is what
//! `webkitwebsrc` asks for (`bytes=N-`) and needs to seek. macOS and Windows
//! keep the asset protocol, which their webviews play natively.
//!
//! **Security.** The server listens on 127.0.0.1 only, on a port the OS picks.
//! Every URL carries one random 256-bit token naming one file, minted only
//! for the main window and only for a file that passes the viewer's gate
//! (`media_preview::validate_preview_source`: under this account's drives or
//! the preview cache). A token expires after [`IDLE`] unused or [`LIFETIME`]
//! in all, belongs to the account that minted it (another account, or none,
//! gets a 404), and is dropped when the viewer closes. The file's real path is
//! checked again on every request, so a file swapped for a link after the
//! token was minted is refused. Requests must name the server's own
//! `Host` (no DNS-rebound name). No CORS headers: a `<video>` without
//! `crossorigin` does not need them, and nothing else should read these bytes.
//! Logout stops the server and forgets every token.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, StreamBody};
use hyper::body::Frame;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use rand::Rng;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::capture::recorder_child::linux_plan::{Distro, Probe};
use crate::error::{AppError, Result};

/// A token unused for this long is gone (a paused video that sat longer
/// reopens from the viewer).
pub const IDLE: Duration = Duration::from_mins(30);
/// No token lives longer than this, used or not.
pub const LIFETIME: Duration = Duration::from_hours(12);
/// At most this many live tokens; minting another drops the least recently
/// used.
const MAX_GRANTS: usize = 64;
/// At most this many open connections; more are closed on accept.
const MAX_CONNECTIONS: usize = 32;
/// One read from disk, one HTTP body frame.
const CHUNK: usize = 256 * 1024;
/// The request path prefix; the token follows.
const PREFIX: &str = "/v/";
/// The viewer gives the player this long to show its first frame
/// (`loadeddata`) before it offers the system's player instead.
pub const START_WITHIN: Duration = Duration::from_secs(8);
/// What the viewer says when the player did not start.
pub const START_FAILED: &str = "This video didn't start in Hippius. Open it in your video player, or download it.";
/// What the viewer says when the stream itself could not start.
pub const STREAM_UNAVAILABLE: &str = "Hippius couldn't get this video ready to play. Open it in your video player, or download it.";
/// The only window that may mint a stream: the one with the file viewer.
const MAIN_WINDOW: &str = "main";

/// What the viewer does with a video, decided here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum VideoPlayback {
    /// macOS and Windows: play the asset URL the viewer already has.
    Webview,
    /// Linux: play this loopback URL; fall back to `start_failed_message`
    /// if no frame arrives within `start_within_ms` or the player errors.
    Stream {
        url: String,
        start_within_ms: u64,
        start_failed_message: String,
    },
    /// Linux without an H.264 decoder: no player, this line instead.
    DecoderMissing { message: String },
    /// The stream could not start (no loopback port); no player.
    Unavailable { message: String },
}

/// Whether this platform plays videos from the loopback stream.
const STREAMS: bool = cfg!(target_os = "linux");

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/// The viewer's line when the recorder child's probe found GStreamer but no
/// H.264 decoder WebKitGTK could use, naming the packages for this family
/// (both families when it is neither). `None` = try to play: a decoder was
/// found, or GStreamer could not be asked (then the start watchdog decides).
/// A missing AAC decoder alone does not stop playback (a silent video still
/// plays), but is named alongside when both are missing.
#[must_use]
pub fn decoder_missing_line(probe: &Probe, distro: Distro) -> Option<String> {
    if !probe.gstreamer || probe.h264_decoder.is_some() {
        return None;
    }
    let aac = probe.aac_decoder.is_some();
    let packages = match distro {
        Distro::Debian => "gstreamer1.0-libav".to_string(),
        Distro::Fedora if aac => "gstreamer1-plugin-openh264".to_string(),
        Distro::Fedora => "gstreamer1-plugin-openh264 and gstreamer1-plugin-libav".to_string(),
        Distro::Other => "gstreamer1.0-libav (Ubuntu, Debian) or gstreamer1-plugin-openh264 (Fedora)".to_string(),
    };
    Some(format!(
        "Videos need an H.264 decoder your system doesn't have. Install {packages}, then restart Hippius."
    ))
}

#[cfg(target_os = "linux")]
async fn decoder_line() -> Option<String> {
    tokio::task::spawn_blocking(crate::capture::recording::linux::video_decoder_missing_line)
        .await
        .ok()
        .flatten()
}

#[cfg(not(target_os = "linux"))]
#[allow(clippy::unused_async)]
async fn decoder_line() -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/// What a request's `Range` header asks of a file of `len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Span {
    /// No usable range: the whole file, 200.
    Whole,
    /// Bytes `start..=end`, 206.
    Part { start: u64, end: u64 },
    /// A well-formed range outside the file, 416.
    Unsatisfiable,
}

/// Parse a `Range` header (RFC 9110 section 14) for a file of `len` bytes.
///
/// One `bytes` range is served: `a-b` (clamped to the file), `a-` (to the
/// end, what WebKitGTK sends) and `-n` (the last `n`). A range that starts at
/// or past the end, or asks for the last zero bytes, is 416. A header that is
/// not a single well-formed `bytes` range (another unit, several ranges,
/// `b < a`, garbage) is ignored and the whole file is served, as the RFC
/// allows; nothing WebKit sends takes that path.
#[must_use]
pub fn parse_range(header: Option<&str>, len: u64) -> Span {
    let Some(header) = header else { return Span::Whole };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return Span::Whole;
    };
    if spec.contains(',') {
        return Span::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Span::Whole;
    };
    let number = |s: &str| -> Option<u64> {
        let s = s.trim();
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    match (first.trim().is_empty(), last.trim().is_empty()) {
        // `-n`: the last n bytes.
        (true, false) => {
            let Some(n) = number(last) else { return Span::Whole };
            if n == 0 || len == 0 {
                return Span::Unsatisfiable;
            }
            Span::Part {
                start: len.saturating_sub(n),
                end: len - 1,
            }
        }
        // `a-`: from a to the end.
        (false, true) => {
            let Some(start) = number(first) else { return Span::Whole };
            if start >= len {
                return Span::Unsatisfiable;
            }
            Span::Part { start, end: len - 1 }
        }
        // `a-b`.
        (false, false) => {
            let (Some(start), Some(end)) = (number(first), number(last)) else {
                return Span::Whole;
            };
            if end < start {
                return Span::Whole;
            }
            if start >= len {
                return Span::Unsatisfiable;
            }
            Span::Part {
                start,
                end: end.min(len - 1),
            }
        }
        (true, true) => Span::Whole,
    }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Grant {
    path: PathBuf,
    account: String,
    minted: Instant,
    used: Instant,
}

impl Grant {
    fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.used) > IDLE || now.saturating_duration_since(self.minted) > LIFETIME
    }
}

/// Why a token was refused (all are a 404 on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Unknown,
    Expired,
    OtherAccount,
}

/// The live tokens: one per opened video, each naming one file.
#[derive(Debug, Default)]
pub struct Grants {
    map: Mutex<HashMap<String, Grant>>,
}

impl Grants {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Grant>> {
        self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A new token for `path` under `account`. Expired tokens and other
    /// accounts' tokens go first; past [`MAX_GRANTS`] the least recently
    /// used goes too.
    pub fn mint(&self, path: PathBuf, account: &str, now: Instant) -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let mut map = self.lock();
        map.retain(|_, g| !g.expired(now) && g.account == account);
        while map.len() >= MAX_GRANTS {
            let Some(oldest) = map.iter().min_by_key(|(_, g)| g.used).map(|(k, _)| k.clone()) else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(
            token.clone(),
            Grant {
                path,
                account: account.to_string(),
                minted: now,
                used: now,
            },
        );
        token
    }

    /// The file `token` names, for the signed-in `account`, marking it used.
    /// An expired token or another account's is forgotten as it is refused.
    ///
    /// # Errors
    ///
    /// [`Refusal`] when the token is unknown, expired or not this account's.
    pub fn resolve(&self, token: &str, account: Option<&str>, now: Instant) -> std::result::Result<PathBuf, Refusal> {
        let mut map = self.lock();
        let grant = map.get_mut(token).ok_or(Refusal::Unknown)?;
        if grant.expired(now) {
            map.remove(token);
            return Err(Refusal::Expired);
        }
        if account != Some(grant.account.as_str()) {
            map.remove(token);
            return Err(Refusal::OtherAccount);
        }
        grant.used = now;
        Ok(grant.path.clone())
    }

    pub fn release(&self, token: &str) {
        self.lock().remove(token);
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// The token in a request path, if the path is exactly `/v/<64 hex>`.
fn token_in(path: &str) -> Option<&str> {
    let token = path.strip_prefix(PREFIX)?;
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())).then_some(token)
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// Who is signed in right now (`None` = nobody); asked on every request.
pub type AccountNow = Arc<dyn Fn() -> Option<String> + Send + Sync>;

type Body = BoxBody<Bytes, std::io::Error>;

struct Running {
    port: u16,
    task: JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        // The accept loop owns every connection's task (a `JoinSet`), so
        // aborting it ends them too.
        self.task.abort();
    }
}

/// The loopback stream: its tokens and, once a video was opened, the server.
#[derive(Default)]
pub struct VideoStreams {
    grants: Arc<Grants>,
    server: tokio::sync::Mutex<Option<Running>>,
}

impl std::fmt::Debug for VideoStreams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoStreams").finish_non_exhaustive()
    }
}

impl VideoStreams {
    /// A URL that plays `path` (already through the gate) for `account`,
    /// starting the server on first use.
    ///
    /// # Errors
    ///
    /// The loopback port could not be opened.
    pub async fn url_for(&self, path: PathBuf, account: &str, account_now: AccountNow) -> std::io::Result<String> {
        let port = self.ensure_running(account_now).await?;
        let token = self.grants.mint(path, account, Instant::now());
        Ok(format!("http://127.0.0.1:{port}{PREFIX}{token}"))
    }

    /// Forget the token in `url` (the viewer closed).
    pub fn release(&self, url: &str) {
        let path = url
            .split_once("://")
            .and_then(|(_, rest)| rest.find('/').map(|i| &rest[i..]))
            .unwrap_or("");
        if let Some(token) = token_in(path) {
            self.grants.release(token);
        }
    }

    /// Stop serving and forget every token (logout).
    pub async fn stop(&self) {
        self.grants.clear();
        self.server.lock().await.take();
    }

    async fn ensure_running(&self, account_now: AccountNow) -> std::io::Result<u16> {
        let mut server = self.server.lock().await;
        if let Some(running) = server.as_ref()
            && !running.task.is_finished()
        {
            return Ok(running.port);
        }
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
        let port = listener.local_addr()?.port();
        let ctx = Arc::new(Ctx {
            grants: self.grants.clone(),
            account_now,
            host: format!("127.0.0.1:{port}"),
        });
        let task = tokio::spawn(accept_loop(listener, ctx));
        tracing::info!(port, "video stream listening on loopback");
        *server = Some(Running { port, task });
        Ok(port)
    }
}

struct Ctx {
    grants: Arc<Grants>,
    account_now: AccountNow,
    host: String,
}

async fn accept_loop(listener: TcpListener, ctx: Arc<Ctx>) {
    let mut connections = JoinSet::new();
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                tracing::warn!(error = %e, "video stream accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        while connections.try_join_next().is_some() {}
        if connections.len() >= MAX_CONNECTIONS {
            continue;
        }
        let ctx = ctx.clone();
        connections.spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let ctx = ctx.clone();
                async move { Ok::<_, Infallible>(answer(&ctx, &request).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
}

fn empty() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

fn status_only(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(empty());
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    response
}

/// The content type for a file, from its extension.
fn content_type(path: &Path) -> String {
    mime_guess::from_path(path).first_raw().unwrap_or("application/octet-stream").to_string()
}

async fn answer<B>(ctx: &Ctx, request: &Request<B>) -> Response<Body> {
    let head = match *request.method() {
        Method::GET => false,
        Method::HEAD => true,
        _ => {
            let mut response = status_only(StatusCode::METHOD_NOT_ALLOWED);
            response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
            return response;
        }
    };
    let host = request.headers().get(header::HOST).and_then(|h| h.to_str().ok());
    if host != Some(ctx.host.as_str()) {
        return status_only(StatusCode::FORBIDDEN);
    }
    let Some(token) = token_in(request.uri().path()) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let path = match ctx.grants.resolve(token, (ctx.account_now)().as_deref(), Instant::now()) {
        Ok(path) => path,
        Err(refusal) => {
            tracing::debug!(?refusal, "video stream refused a token");
            return status_only(StatusCode::NOT_FOUND);
        }
    };
    // The path was canonical when the token was minted; a link swapped in
    // since would resolve elsewhere.
    match tokio::fs::canonicalize(&path).await {
        Ok(real) if real == path => {}
        _ => return status_only(StatusCode::NOT_FOUND),
    }
    let Ok(mut file) = tokio::fs::File::open(&path).await else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let len = match file.metadata().await {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return status_only(StatusCode::NOT_FOUND),
    };
    let range = request.headers().get(header::RANGE).and_then(|h| h.to_str().ok());
    let span = parse_range(range, len);

    let (status, start, count) = match span {
        Span::Whole => (StatusCode::OK, 0, len),
        Span::Part { start, end } => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        Span::Unsatisfiable => {
            let mut response = status_only(StatusCode::RANGE_NOT_SATISFIABLE);
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{len}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            response.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            return response;
        }
    };

    let body = if head || count == 0 {
        empty()
    } else {
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return status_only(StatusCode::INTERNAL_SERVER_ERROR);
        }
        file_body(file, count)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(count));
    if let Ok(value) = HeaderValue::from_str(&content_type(&path)) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if let Span::Part { start, end } = span
        && let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{len}"))
    {
        headers.insert(header::CONTENT_RANGE, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

/// `count` bytes of `file` from where it is, read [`CHUNK`] at a time: the
/// file is never held whole in memory.
fn file_body(file: tokio::fs::File, count: u64) -> Body {
    let stream = futures_util::stream::unfold((file, count), |(mut file, left)| async move {
        if left == 0 {
            return None;
        }
        let want = usize::try_from(left.min(CHUNK as u64)).unwrap_or(CHUNK);
        let mut buf = vec![0u8; want];
        match file.read(&mut buf).await {
            // The file shrank: end early (the client sees a short body).
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Frame::data(Bytes::from(buf))), (file, left - n as u64)))
            }
            Err(e) => Some((Err(e), (file, 0))),
        }
    });
    StreamBody::new(stream).boxed()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// How the viewer plays the video at `source_path` (its local copy: in a
/// drive, or decrypted into the preview cache). macOS and Windows play the
/// asset URL; Linux gets a loopback URL, or a line when it has no H.264
/// decoder. Only the main window may ask, and only for a file the viewer's
/// gate allows.
///
/// # Errors
///
/// Another window asked, nobody is signed in, or the file is outside the gate.
#[tauri::command]
pub async fn video_playback_source(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, crate::app_state::AppState>,
    source_path: String,
) -> Result<VideoPlayback> {
    if !STREAMS {
        return Ok(VideoPlayback::Webview);
    }
    if webview.label() != MAIN_WINDOW {
        return Err(AppError::Validation("only the main window plays videos".into()));
    }
    let path = crate::media_preview::validate_preview_source(&state, Path::new(&source_path)).await?;
    if let Some(message) = decoder_line().await {
        return Ok(VideoPlayback::DecoderMissing { message });
    }
    let account = state.current_account_id()?;
    let account_now: AccountNow = Arc::new(move || {
        use tauri::Manager;
        app.try_state::<crate::app_state::AppState>()?.current_account_id().ok()
    });
    match state.video_stream.url_for(path, &account, account_now).await {
        Ok(url) => Ok(VideoPlayback::Stream {
            url,
            start_within_ms: u64::try_from(START_WITHIN.as_millis()).unwrap_or(8000),
            start_failed_message: START_FAILED.to_string(),
        }),
        Err(e) => {
            tracing::warn!(error = %e, "video stream could not open a loopback port");
            Ok(VideoPlayback::Unavailable {
                message: STREAM_UNAVAILABLE.to_string(),
            })
        }
    }
}

/// The viewer closed: forget the token in `url`.
#[tauri::command]
pub fn video_stream_release(state: tauri::State<'_, crate::app_state::AppState>, url: String) {
    state.video_stream.release(&url);
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEN: u64 = 1000;

    #[test]
    fn no_range_is_the_whole_file() {
        assert_eq!(parse_range(None, LEN), Span::Whole);
    }

    #[test]
    fn a_closed_range_is_served_and_clamped_to_the_file() {
        assert_eq!(parse_range(Some("bytes=0-99"), LEN), Span::Part { start: 0, end: 99 });
        assert_eq!(parse_range(Some("bytes=900-5000"), LEN), Span::Part { start: 900, end: 999 });
        assert_eq!(parse_range(Some("bytes=5-5"), LEN), Span::Part { start: 5, end: 5 });
    }

    /// WebKitGTK's `webkitwebsrc` asks `bytes=N-` for every read and seek.
    #[test]
    fn an_open_ended_range_runs_to_the_end() {
        assert_eq!(parse_range(Some("bytes=0-"), LEN), Span::Part { start: 0, end: 999 });
        assert_eq!(parse_range(Some("bytes=999-"), LEN), Span::Part { start: 999, end: 999 });
        assert_eq!(parse_range(Some(" bytes=400- "), LEN), Span::Part { start: 400, end: 999 });
    }

    #[test]
    fn a_suffix_range_is_the_last_bytes() {
        assert_eq!(parse_range(Some("bytes=-100"), LEN), Span::Part { start: 900, end: 999 });
        // Longer than the file: the whole file, as a 206.
        assert_eq!(parse_range(Some("bytes=-5000"), LEN), Span::Part { start: 0, end: 999 });
    }

    #[test]
    fn a_range_outside_the_file_is_416() {
        assert_eq!(parse_range(Some("bytes=1000-"), LEN), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=1000-1200"), LEN), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), LEN), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-10"), 0), Span::Unsatisfiable);
    }

    /// RFC 9110: a Range the server does not understand is ignored.
    #[test]
    fn a_malformed_range_is_ignored() {
        for bad in [
            "items=0-1",
            "bytes=",
            "bytes=-",
            "bytes=a-b",
            "bytes=5-1",
            "bytes=0-1,5-6",
            "bytes=+1-2",
            "0-1",
        ] {
            assert_eq!(parse_range(Some(bad), LEN), Span::Whole, "{bad}");
        }
    }

    #[test]
    fn a_token_names_its_file_for_its_account_only() {
        let grants = Grants::default();
        let now = Instant::now();
        let token = grants.mint(PathBuf::from("/drive/a.mp4"), "alice", now);
        assert_eq!(token.len(), 64);
        assert_eq!(grants.resolve(&token, Some("alice"), now), Ok(PathBuf::from("/drive/a.mp4")));
        assert_eq!(grants.resolve("f".repeat(64).as_str(), Some("alice"), now), Err(Refusal::Unknown));
        // Another account (an account switch) or nobody: refused and forgotten.
        assert_eq!(grants.resolve(&token, Some("bob"), now), Err(Refusal::OtherAccount));
        assert_eq!(grants.resolve(&token, Some("alice"), now), Err(Refusal::Unknown));
        let token = grants.mint(PathBuf::from("/drive/a.mp4"), "alice", now);
        assert_eq!(grants.resolve(&token, None, now), Err(Refusal::OtherAccount));
        // Two mints are two different tokens.
        let a = grants.mint(PathBuf::from("/x"), "alice", now);
        let b = grants.mint(PathBuf::from("/x"), "alice", now);
        assert_ne!(a, b);
    }

    #[test]
    fn a_token_expires_when_idle_and_after_its_lifetime() {
        let grants = Grants::default();
        let start = Instant::now();
        let token = grants.mint(PathBuf::from("/drive/a.mp4"), "alice", start);
        // Used within the idle window: still good, and the window moves.
        let almost = IDLE.saturating_sub(Duration::from_secs(1));
        let later = start + almost;
        assert!(grants.resolve(&token, Some("alice"), later).is_ok());
        let later = later + almost;
        assert!(grants.resolve(&token, Some("alice"), later).is_ok());
        // Idle too long: expired, and gone.
        let idle = later + IDLE + Duration::from_secs(1);
        assert_eq!(grants.resolve(&token, Some("alice"), idle), Err(Refusal::Expired));
        assert_eq!(grants.resolve(&token, Some("alice"), idle), Err(Refusal::Unknown));

        // Kept busy, it still ends at its lifetime.
        let token = grants.mint(PathBuf::from("/drive/a.mp4"), "alice", start);
        let mut now = start;
        while now < start + LIFETIME {
            assert!(grants.resolve(&token, Some("alice"), now).is_ok());
            now += IDLE / 2;
        }
        assert_eq!(
            grants.resolve(&token, Some("alice"), start + LIFETIME + Duration::from_secs(1)),
            Err(Refusal::Expired)
        );
    }

    #[test]
    fn minting_drops_stale_tokens_and_stays_bounded() {
        let grants = Grants::default();
        let start = Instant::now();
        let old = grants.mint(PathBuf::from("/a"), "alice", start);
        let bob = grants.mint(PathBuf::from("/b"), "bob", start + Duration::from_secs(1));
        assert_eq!(grants.len(), 1, "minting for bob dropped alice's token");
        let _ = old;
        for i in 0..(MAX_GRANTS + 10) {
            grants.mint(PathBuf::from(format!("/b{i}")), "bob", start + Duration::from_secs(2 + i as u64));
        }
        assert_eq!(grants.len(), MAX_GRANTS);
        assert_eq!(grants.resolve(&bob, Some("bob"), start + Duration::from_secs(100)), Err(Refusal::Unknown));
        grants.clear();
        assert_eq!(grants.len(), 0);
    }

    #[test]
    fn only_a_whole_token_path_is_a_token() {
        let token = "a".repeat(64);
        assert_eq!(token_in(&format!("/v/{token}")), Some(token.as_str()));
        assert_eq!(token_in(&format!("/v/{token}/x")), None);
        assert_eq!(token_in(&format!("/v/{}", "a".repeat(63))), None);
        assert_eq!(token_in(&format!("/v/{}", "g".repeat(64))), None);
        assert_eq!(token_in(&format!("/x/{token}")), None);
        assert_eq!(token_in("/v/../../etc/passwd"), None);
    }

    #[test]
    fn the_decoder_line_names_the_package_for_this_system() {
        let found = Probe {
            gstreamer: true,
            h264_decoder: Some("avdec_h264".into()),
            aac_decoder: Some("avdec_aac".into()),
            ..Probe::default()
        };
        assert_eq!(decoder_missing_line(&found, Distro::Debian), None);
        // Only AAC missing: a video still plays (maybe silent).
        let no_aac = Probe {
            aac_decoder: None,
            ..found.clone()
        };
        assert_eq!(decoder_missing_line(&no_aac, Distro::Debian), None);
        // GStreamer could not be asked: try, and let the watchdog decide.
        assert_eq!(decoder_missing_line(&Probe::default(), Distro::Debian), None);

        let no_h264 = Probe {
            h264_decoder: None,
            ..found.clone()
        };
        assert_eq!(
            decoder_missing_line(&no_h264, Distro::Debian).unwrap(),
            "Videos need an H.264 decoder your system doesn't have. Install gstreamer1.0-libav, then restart Hippius."
        );
        assert!(
            decoder_missing_line(&no_h264, Distro::Fedora)
                .unwrap()
                .contains("Install gstreamer1-plugin-openh264, then")
        );
        let neither = Probe {
            h264_decoder: None,
            aac_decoder: None,
            ..found
        };
        assert!(
            decoder_missing_line(&neither, Distro::Fedora)
                .unwrap()
                .contains("gstreamer1-plugin-openh264 and gstreamer1-plugin-libav")
        );
        let other = decoder_missing_line(&neither, Distro::Other).unwrap();
        assert!(
            other.contains("gstreamer1.0-libav") && other.contains("gstreamer1-plugin-openh264"),
            "{other}"
        );
    }

    #[test]
    fn the_viewer_gets_camel_case_kinds() {
        let json = serde_json::to_value(VideoPlayback::Stream {
            url: "http://127.0.0.1:1/v/x".into(),
            start_within_ms: 8000,
            start_failed_message: START_FAILED.into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "stream");
        assert_eq!(json["startWithinMs"], 8000);
        assert_eq!(json["startFailedMessage"], START_FAILED);
        assert_eq!(serde_json::to_value(VideoPlayback::Webview).unwrap()["kind"], "webview");
        let missing = serde_json::to_value(VideoPlayback::DecoderMissing { message: "m".into() }).unwrap();
        assert_eq!(
            (missing["kind"].as_str(), missing["message"].as_str()),
            (Some("decoderMissing"), Some("m"))
        );
    }

    // -- The server itself, on a real loopback socket. --

    struct Served {
        streams: VideoStreams,
        account: Arc<Mutex<Option<String>>>,
        dir: tempfile::TempDir,
        file: PathBuf,
        bytes: Vec<u8>,
    }

    async fn served() -> (Served, String) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Recording.mp4");
        let bytes: Vec<u8> = (0..(CHUNK * 2 + 123)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &bytes).unwrap();
        let file = std::fs::canonicalize(&file).unwrap();
        let account = Arc::new(Mutex::new(Some("alice".to_string())));
        let now = account.clone();
        let account_now: AccountNow = Arc::new(move || now.lock().unwrap().clone());
        let streams = VideoStreams::default();
        let url = streams.url_for(file.clone(), "alice", account_now).await.unwrap();
        (
            Served {
                streams,
                account,
                dir,
                file,
                bytes,
            },
            url,
        )
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn serves_ranges_head_and_the_whole_file_from_loopback() {
        let (s, url) = served().await;
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        let len = s.bytes.len();

        // What WebKitGTK sends first: an open-ended range.
        let r = client().get(&url).header("Range", "bytes=0-").send().await.unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.headers()["accept-ranges"], "bytes");
        assert_eq!(r.headers()["content-type"], "video/mp4");
        assert_eq!(r.headers()["content-range"], format!("bytes 0-{}/{len}", len - 1).as_str());
        assert_eq!(r.headers()["content-length"], len.to_string().as_str());
        assert!(r.headers().get("access-control-allow-origin").is_none(), "no CORS");
        assert_eq!(r.bytes().await.unwrap().as_ref(), s.bytes.as_slice());

        // A seek into the middle, across a chunk boundary.
        let (a, b) = (CHUNK - 10, CHUNK + 20);
        let r = client().get(&url).header("Range", format!("bytes={a}-{b}")).send().await.unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.headers()["content-range"], format!("bytes {a}-{b}/{len}").as_str());
        assert_eq!(r.bytes().await.unwrap().as_ref(), &s.bytes[a..=b]);

        // The index at the end (a suffix range).
        let r = client().get(&url).header("Range", "bytes=-16").send().await.unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.bytes().await.unwrap().as_ref(), &s.bytes[len - 16..]);

        // Outside the file.
        let r = client().get(&url).header("Range", format!("bytes={len}-")).send().await.unwrap();
        assert_eq!(r.status(), 416);
        assert_eq!(r.headers()["content-range"], format!("bytes */{len}").as_str());

        // No range: 200, the whole file.
        let r = client().get(&url).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.bytes().await.unwrap().len(), len);

        // HEAD: the headers a GET would get, no body.
        let r = client().head(&url).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-length"], len.to_string().as_str());
        assert_eq!(r.headers()["accept-ranges"], "bytes");

        // Nothing but GET and HEAD.
        let r = client().post(&url).send().await.unwrap();
        assert_eq!(r.status(), 405);
    }

    #[tokio::test]
    async fn refuses_other_hosts_other_tokens_other_accounts_and_after_stop() {
        let (s, url) = served().await;
        let port_url = url.rsplit_once("/v/").unwrap().0.to_string();

        // A name rebound to 127.0.0.1 still names itself in Host.
        let r = client().get(&url).header("Host", "evil.example").send().await.unwrap();
        assert_eq!(r.status(), 403);
        // An unknown token, or a path that is not a token.
        let r = client().get(format!("{port_url}/v/{}", "0".repeat(64))).send().await.unwrap();
        assert_eq!(r.status(), 404);
        let r = client().get(format!("{port_url}/etc/passwd")).send().await.unwrap();
        assert_eq!(r.status(), 404);

        // Released by the viewer: gone.
        s.streams.release(&url);
        assert_eq!(client().get(&url).send().await.unwrap().status(), 404);

        // Another account signed in: refused.
        let token = s.streams.grants.mint(s.file.clone(), "alice", Instant::now());
        let url = format!("{port_url}/v/{token}");
        assert_eq!(client().head(&url).send().await.unwrap().status(), 200);
        *s.account.lock().unwrap() = Some("bob".into());
        assert_eq!(client().head(&url).send().await.unwrap().status(), 404);

        // Logout: the server stops.
        *s.account.lock().unwrap() = Some("alice".into());
        let token = s.streams.grants.mint(s.file.clone(), "alice", Instant::now());
        let url = format!("{port_url}/v/{token}");
        assert_eq!(client().head(&url).send().await.unwrap().status(), 200);
        s.streams.stop().await;
        let mut stopped = false;
        for _ in 0..50 {
            if client().head(&url).send().await.is_err() {
                stopped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(stopped, "nothing listens after stop");
    }

    /// A file replaced by a link after its token was minted is not followed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_file_swapped_for_a_link_is_refused() {
        let (s, url) = served().await;
        let elsewhere = s.dir.path().join("secret.txt");
        std::fs::write(&elsewhere, b"secret").unwrap();
        std::fs::remove_file(&s.file).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &s.file).unwrap();
        assert_eq!(client().get(&url).send().await.unwrap().status(), 404);
    }
}

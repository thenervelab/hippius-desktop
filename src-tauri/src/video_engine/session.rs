//! One transcoded preview: the engine child, the segments it has made, and
//! restart-on-seek.
//!
//! The player asks for segment `k`. If it is in memory it is returned. If
//! the running engine will reach it soon (at most [`RESTART_GAP`] segments
//! ahead of where it is), the request waits for it. Otherwise (a seek) the
//! engine is killed and restarted at `k`, which takes about as long as one
//! segment takes to convert.
//!
//! **Nothing is written to disk.** The engine writes to a pipe and segments
//! live in memory, at most [`MAX_HELD`] of them. The pipe also bounds the
//! work: the reader stops reading once it is [`AHEAD`] segments past the
//! last request, the pipe fills, and the engine blocks on its write instead
//! of converting the whole film. And it is the cleanup of last resort: if
//! the app dies, the engine's next write fails and it exits.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::plan::{self, AudioPlan, Encoder};
use super::probe::MediaInfo;
use super::segmenter::Segmenter;

/// The reader stops this many segments past the last request.
pub const AHEAD: u32 = 5;
/// A request this far past the engine's position restarts it rather than
/// waiting for it to get there.
pub const RESTART_GAP: u32 = 3;
/// Segments kept in memory, the furthest from the last request dropped
/// first (about 36 MB at 1080p).
pub const MAX_HELD: usize = 12;
/// How long one request waits for its segment.
pub const SEGMENT_WAIT: Duration = Duration::from_mins(1);

/// Why a segment could not be had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmentFailure {
    /// Past the end of the playlist.
    OutOfRange,
    /// The engine failed (its last error line, for the log).
    Engine(String),
    /// It did not come within [`SEGMENT_WAIT`].
    TimedOut,
    /// The session was closed.
    Closed,
    /// A newer request (the player seeked elsewhere) owns the engine now;
    /// this one would have had to restart it.
    Superseded,
}

#[derive(Debug, Default)]
struct Producer {
    /// The next segment it will finish.
    next: u32,
    /// It reached the end of the file (or failed).
    ended: bool,
    failure: Option<String>,
}

#[derive(Debug, Default)]
struct Inner {
    segments: BTreeMap<u32, Bytes>,
    producer: Option<Producer>,
    task: Option<JoinHandle<()>>,
    last_requested: u32,
    generation: u64,
    closed: bool,
    /// The running engine's process id (diagnostics and tests).
    pid: Option<u32>,
    /// The ticket of the newest request. Only it may restart the engine or
    /// move the read-ahead window: a request the player abandoned on a seek
    /// is still waiting here, and letting it restart the engine back where
    /// it was would fight the seek for as long as both wait.
    latest: u64,
}

/// How the engine is run: its path and arguments for a start segment.
pub trait Launcher: Send + Sync + 'static {
    /// The program and arguments for a run starting at `start_index`.
    fn command(&self, start_index: u32) -> (PathBuf, Vec<String>);
}

/// The real launcher: the engine binary, the transcode arguments.
#[derive(Debug, Clone)]
pub struct EngineLauncher {
    pub engine: PathBuf,
    pub input: String,
    pub info: MediaInfo,
    pub encoder: Encoder,
    pub audio: AudioPlan,
}

impl Launcher for EngineLauncher {
    fn command(&self, start_index: u32) -> (PathBuf, Vec<String>) {
        (
            self.engine.clone(),
            plan::transcode_args(&self.input, &self.info, self.encoder, self.audio, start_index),
        )
    }
}

pub struct HlsSession {
    pub duration: f64,
    count: u32,
    launcher: Arc<dyn Launcher>,
    inner: Mutex<Inner>,
    /// Bumped whenever a segment lands or a run ends.
    changed: watch::Sender<u64>,
}

impl std::fmt::Debug for HlsSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HlsSession").field("duration", &self.duration).finish_non_exhaustive()
    }
}

impl HlsSession {
    #[must_use]
    pub fn new(duration: f64, launcher: Arc<dyn Launcher>) -> Arc<Self> {
        Arc::new(Self {
            duration,
            count: plan::segment_count(duration),
            launcher,
            inner: Mutex::new(Inner::default()),
            changed: watch::channel(0).0,
        })
    }

    #[must_use]
    pub fn playlist(&self) -> String {
        plan::playlist(self.duration)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Segment `index`, converting it if needed.
    ///
    /// # Errors
    ///
    /// [`SegmentFailure`]: out of range, the engine failed, too slow, closed.
    pub async fn segment(self: &Arc<Self>, index: u32) -> Result<Bytes, SegmentFailure> {
        if index >= self.count {
            return Err(SegmentFailure::OutOfRange);
        }
        let deadline = tokio::time::Instant::now() + SEGMENT_WAIT;
        let mut changes = self.changed.subscribe();
        let mut restarted = false;
        let ticket = {
            let mut inner = self.lock();
            inner.latest += 1;
            inner.latest
        };
        loop {
            {
                let mut inner = self.lock();
                if inner.closed {
                    return Err(SegmentFailure::Closed);
                }
                let newest = inner.latest == ticket;
                if newest {
                    inner.last_requested = index;
                }
                if let Some(bytes) = inner.segments.get(&index) {
                    let bytes = bytes.clone();
                    evict(&mut inner.segments, index);
                    drop(inner);
                    self.changed.send_modify(|v| *v += 1); // wakes a reader held back by AHEAD
                    return Ok(bytes);
                }
                let restart = match &inner.producer {
                    None => true,
                    Some(p) if p.failure.is_some() && restarted => {
                        return Err(SegmentFailure::Engine(p.failure.clone().unwrap_or_default()));
                    }
                    // Behind the run (a seek back past what is held), too
                    // far ahead of it, or past where it ended: a new run.
                    Some(p) => p.failure.is_some() || index < p.next || index > p.next + RESTART_GAP || p.ended,
                };
                if restart {
                    if !newest {
                        return Err(SegmentFailure::Superseded);
                    }
                    if restarted && inner.producer.as_ref().is_some_and(|p| p.ended) {
                        // A fresh run from here ended without this segment:
                        // the file is shorter than its header said.
                        return Err(SegmentFailure::OutOfRange);
                    }
                    self.start(&mut inner, index);
                    restarted = true;
                }
            }
            self.changed.send_modify(|v| *v += 1);
            match tokio::time::timeout_at(deadline, changes.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(SegmentFailure::Closed),
                Err(_) => return Err(SegmentFailure::TimedOut),
            }
        }
    }

    /// Kill any running engine and start one at `index`.
    fn start(self: &Arc<Self>, inner: &mut Inner, index: u32) {
        if let Some(task) = inner.task.take() {
            task.abort(); // drops the child: kill_on_drop
        }
        inner.generation += 1;
        let generation = inner.generation;
        inner.producer = Some(Producer {
            next: index,
            ..Producer::default()
        });
        let me = Arc::clone(self);
        inner.task = Some(tokio::spawn(async move { me.run(index, generation).await }));
    }

    /// Stop the engine and drop every segment.
    pub fn close(&self) {
        let mut inner = self.lock();
        inner.closed = true;
        inner.segments.clear();
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        drop(inner);
        self.changed.send_modify(|v| *v += 1);
    }

    /// Whether an engine run is in progress for this session.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.lock().task.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// The process id of the latest engine run, if one was started.
    #[must_use]
    pub fn engine_pid(&self) -> Option<u32> {
        self.lock().pid
    }

    async fn run(self: Arc<Self>, start: u32, generation: u64) {
        let (program, args) = self.launcher.command(start);
        let child = super::engine::command(&program)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(e) => {
                tracing::warn!(error = %e, "video engine did not start");
                self.end_run(generation, Some(format!("spawn: {e}")));
                return;
            }
        };
        {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.pid = child.id();
            }
        }
        let stderr = child.stderr.take().map(|s| tokio::spawn(last_line(s)));
        let Some(mut stdout) = child.stdout.take() else {
            self.end_run(generation, Some("no stdout".into()));
            return;
        };
        let mut segmenter = Segmenter::new(start);
        let mut buf = vec![0u8; 256 * 1024];
        let mut failure = None;
        let mut changes = self.changed.subscribe();
        loop {
            // Back-pressure: wait while far enough ahead of the player.
            loop {
                let ahead = {
                    let inner = self.lock();
                    if inner.generation != generation || inner.closed {
                        return;
                    }
                    inner.producer.as_ref().map_or(0, |p| p.next).saturating_sub(inner.last_requested)
                };
                if ahead < AHEAD {
                    break;
                }
                if changes.changed().await.is_err() {
                    return;
                }
            }
            let n = match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    failure = Some(format!("read: {e}"));
                    break;
                }
            };
            match segmenter.push(&buf[..n]) {
                Ok(done) => self.store(generation, done),
                Err(e) => {
                    failure = Some(format!("{e:?}"));
                    break;
                }
            }
        }
        if failure.is_none() {
            self.store(generation, segmenter.finish().into_iter().collect());
        }
        let status = child.wait().await;
        let last = match stderr {
            Some(task) => task.await.unwrap_or_default(),
            None => String::new(),
        };
        if failure.is_none() && !status.as_ref().is_ok_and(std::process::ExitStatus::success) {
            failure = Some(if last.is_empty() { format!("{status:?}") } else { last });
        }
        if let Some(f) = &failure {
            tracing::warn!(failure = %f, start, "video engine run failed");
        }
        self.end_run(generation, failure);
    }

    fn store(&self, generation: u64, done: Vec<(u32, Bytes)>) {
        if done.is_empty() {
            return;
        }
        let mut inner = self.lock();
        if inner.generation != generation || inner.closed {
            return;
        }
        for (index, bytes) in done {
            inner.segments.insert(index, bytes);
            if let Some(p) = inner.producer.as_mut() {
                p.next = p.next.max(index + 1);
            }
        }
        let keep = inner.last_requested;
        evict(&mut inner.segments, keep);
        drop(inner);
        self.changed.send_modify(|v| *v += 1);
    }

    fn end_run(&self, generation: u64, failure: Option<String>) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        if let Some(p) = inner.producer.as_mut() {
            p.ended = true;
            p.failure = failure;
        }
        drop(inner);
        self.changed.send_modify(|v| *v += 1);
    }
}

impl Drop for HlsSession {
    fn drop(&mut self) {
        if let Some(task) = self.inner.get_mut().ok().and_then(|i| i.task.take()) {
            task.abort();
        }
    }
}

/// Keep at most [`MAX_HELD`] segments, dropping the furthest from `around`.
fn evict(segments: &mut BTreeMap<u32, Bytes>, around: u32) {
    while segments.len() > MAX_HELD {
        let furthest = segments.keys().copied().max_by_key(|k| k.abs_diff(around));
        match furthest {
            Some(k) => {
                segments.remove(&k);
            }
            None => break,
        }
    }
}

/// The last non-empty line the engine printed to stderr (its error).
async fn last_line(mut stderr: impl AsyncRead + Unpin) -> String {
    let mut all = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        all.extend_from_slice(&buf[..n]);
        if all.len() > 16 * 1024 {
            all.drain(..all.len() - 8 * 1024);
        }
    }
    String::from_utf8_lossy(&all)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eviction_drops_the_segments_furthest_from_the_player() {
        let mut map: BTreeMap<u32, Bytes> = (0..20).map(|i| (i, Bytes::new())).collect();
        evict(&mut map, 10);
        assert_eq!(map.len(), MAX_HELD);
        assert!(map.contains_key(&10) && map.contains_key(&4) && map.contains_key(&15));
        assert!(!map.contains_key(&0) && !map.contains_key(&19));
    }
}

//! The video preview engine run for real: a generated WMV is converted
//! segment by segment, a seek restarts the conversion where it lands, a
//! playable MKV is remuxed, and closing a preview kills its engine.
//!
//! Needs the engine binary (`scripts/video-engine/build-ffmpeg.sh`). It is
//! found at `$HIPPIUS_VIDEO_ENGINE`, else at `binaries/hippius-ffmpeg-<host>`.
//! Without one these tests return early, unless `HIPPIUS_REQUIRE_VIDEO_ENGINE=1`
//! (the CI job that builds the engine sets it), where a missing engine fails.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri_project_lib::video_engine::engine::{self, pick_encoder, probe};
use tauri_project_lib::video_engine::plan::{self, AudioPlan, Decision, Platform, SEGMENT_SECS};
use tauri_project_lib::video_engine::remux;
use tauri_project_lib::video_engine::session::{EngineLauncher, HlsSession, SegmentFailure};

fn engine_path() -> Option<PathBuf> {
    let from_env = std::env::var_os("HIPPIUS_VIDEO_ENGINE").map(PathBuf::from);
    let triple = std::env::var("TARGET").ok().or_else(host_triple);
    let bundled = triple.map(|t| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("hippius-ffmpeg-{t}{}", std::env::consts::EXE_SUFFIX))
    });
    let found = from_env.or(bundled).filter(|p| p.is_file());
    assert!(
        found.is_some() || std::env::var("HIPPIUS_REQUIRE_VIDEO_ENGINE").as_deref() != Ok("1"),
        "HIPPIUS_REQUIRE_VIDEO_ENGINE=1 but no engine was found"
    );
    found
}

fn host_triple() -> Option<String> {
    let out = std::process::Command::new("rustc").arg("-vV").output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("host: ").map(str::to_string))
}

/// Make a fixture with the engine itself (nothing binary is committed).
fn generate(engine: &Path, out: &Path, seconds: u32, codec_args: &[&str]) {
    let status = std::process::Command::new(engine)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
        .arg("testsrc2=size=320x240:rate=25")
        .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t"])
        .arg(seconds.to_string())
        .args(codec_args)
        .arg(out)
        .status()
        .expect("engine runs");
    assert!(status.success(), "fixture {} was not generated", out.display());
}

const PACKET: usize = 188;

/// The first video PTS in a transport stream, in seconds.
fn first_video_pts(ts: &[u8]) -> Option<f64> {
    ts.chunks(PACKET).find_map(|p| {
        if p[1] & 0x40 == 0 {
            return None;
        }
        let off = if (p[3] >> 4) & 2 != 0 { 5 + usize::from(p[4]) } else { 4 };
        let pes = p.get(off..)?;
        if pes.len() < 14 || pes[..3] != [0, 0, 1] || !(0xE0..=0xEF).contains(&pes[3]) || pes[7] & 0x80 == 0 {
            return None;
        }
        let b = &pes[9..14];
        let pts = (u64::from(b[0] >> 1) & 7) << 30 | u64::from(b[1]) << 22 | u64::from(b[2] >> 1) << 15 | u64::from(b[3]) << 7 | u64::from(b[4] >> 1);
        #[allow(clippy::cast_precision_loss)]
        Some(pts as f64 / 90_000.0)
    })
}

fn assert_transport_stream(segment: &[u8]) {
    assert!(!segment.is_empty());
    assert_eq!(segment.len() % PACKET, 0, "whole packets");
    assert!(segment.chunks(PACKET).all(|p| p[0] == 0x47), "every packet starts with the sync byte");
}

async fn wmv_session(engine: &Path, dir: &Path, seconds: u32) -> Option<(Arc<HlsSession>, f64)> {
    let wmv = dir.join("clip.wmv");
    generate(engine, &wmv, seconds, &["-c:v", "wmv2", "-b:v", "500k", "-c:a", "wmav2", "-b:a", "64k"]);
    let info = probe(engine, &wmv).await.expect("the engine reads its own WMV");
    assert_eq!(info.video.as_ref().map(|v| v.codec.as_str()), Some("wmv2"));
    assert_eq!(info.audio.as_ref().map(|a| a.codec.as_str()), Some("wmav2"));
    assert_eq!(plan::decide(&info, Platform::current()), Decision::Transcode);
    let duration = info.duration.expect("duration");
    assert!((duration - f64::from(seconds)).abs() < 0.5, "{duration}");
    let Some(encoder) = pick_encoder(engine, Platform::current()).await else {
        assert!(
            std::env::var("HIPPIUS_REQUIRE_VIDEO_ENGINE").as_deref() != Ok("1"),
            "no H.264 encoder works here"
        );
        return None;
    };
    let launcher = EngineLauncher {
        engine: engine.to_path_buf(),
        input: wmv.to_string_lossy().into_owned(),
        info,
        encoder,
    };
    Some((HlsSession::new(duration, Arc::new(launcher)), duration))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wmv_converts_into_h264_aac_segments_that_cover_its_whole_length() {
    let Some(engine) = engine_path() else { return };
    let dir = tempfile::tempdir().unwrap();
    let Some((session, duration)) = wmv_session(&engine, dir.path(), 10).await else {
        return;
    };
    let count = plan::segment_count(duration);
    assert_eq!(count, 3);

    let mut whole = Vec::new();
    for index in 0..count {
        let segment = session.segment(index).await.unwrap_or_else(|e| panic!("segment {index}: {e:?}"));
        assert_transport_stream(&segment);
        let pts = first_video_pts(&segment).expect("a video PES");
        // Every engine run starts its clock at 1.4 s; segment k is k * 4 s on.
        let expected = 1.4 + f64::from(index * SEGMENT_SECS);
        assert!((pts - expected).abs() < 0.2, "segment {index} starts at {pts}, expected {expected}");
        whole.extend_from_slice(&segment);
    }
    assert_eq!(session.segment(count).await, Err(SegmentFailure::OutOfRange));

    // The joined segments are one valid H.264 + AAC stream as long as the WMV.
    let joined = dir.path().join("joined.ts");
    std::fs::write(&joined, &whole).unwrap();
    let out = probe(&engine, &joined).await.expect("the output is readable");
    assert_eq!(out.video.as_ref().map(|v| v.codec.as_str()), Some("h264"));
    assert_eq!(out.video.as_ref().map(|v| (v.width, v.height)), Some((320, 240)));
    assert_eq!(out.audio.as_ref().map(|a| a.codec.as_str()), Some("aac"));
    let got = out.duration.expect("duration");
    assert!((got - duration).abs() < 0.5, "converted {got} s of {duration} s");
    session.close();
}

/// A seek far ahead restarts the engine at that segment; a held segment is
/// served without one; and a request the player abandoned on a seek never
/// drags the engine back from where the newest request put it.
#[tokio::test(flavor = "multi_thread")]
async fn a_seek_restarts_the_conversion_where_it_lands() {
    let Some(engine) = engine_path() else { return };
    let dir = tempfile::tempdir().unwrap();
    let Some((session, _)) = wmv_session(&engine, dir.path(), 60).await else {
        return;
    };

    let first = session.segment(0).await.unwrap();
    let first_pid = session.engine_pid();
    let far = session.segment(6).await.unwrap();
    assert_ne!(session.engine_pid(), first_pid, "a new engine run for the seek");
    let pts = first_video_pts(&far).unwrap();
    assert!((pts - (1.4 + 24.0)).abs() < 0.2, "segment 6 starts at {pts}");
    // Segment 0 is still held: no restart for it.
    let pid = session.engine_pid();
    assert_eq!(session.segment(0).await.unwrap(), first);
    assert_eq!(session.engine_pid(), pid);

    // Two seeks in a row: the first request is still waiting when the
    // second arrives, as when the player is dragged along the timeline.
    let abandoned = {
        let session = Arc::clone(&session);
        tokio::spawn(async move { session.segment(1).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    let latest = session.segment(12).await.unwrap();
    let pts = first_video_pts(&latest).unwrap();
    assert!((pts - (1.4 + 48.0)).abs() < 0.2, "segment 12 starts at {pts}");
    let abandoned = abandoned.await.unwrap();
    assert!(matches!(abandoned, Ok(_) | Err(SegmentFailure::Superseded)), "{abandoned:?}");
    // The engine stayed where the newest request put it.
    let pid = session.engine_pid();
    session.segment(13).await.unwrap();
    assert_eq!(session.engine_pid(), pid, "segment 13 came from the same run");
    session.close();
}

/// Closing a preview ends its engine process; no orphan converts on.
#[tokio::test(flavor = "multi_thread")]
async fn closing_a_preview_kills_its_engine() {
    let Some(engine) = engine_path() else { return };
    let dir = tempfile::tempdir().unwrap();
    let Some((session, _)) = wmv_session(&engine, dir.path(), 60).await else {
        return;
    };
    session.segment(0).await.unwrap();
    let pid = session.engine_pid().expect("an engine ran");
    assert!(session.is_running(), "held back by the read-ahead limit, not finished");
    session.close();
    assert_eq!(session.segment(1).await, Err(SegmentFailure::Closed));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while process_alive(pid) {
        assert!(std::time::Instant::now() < deadline, "engine {pid} still running after close");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!session.is_running());
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // A killed child the runtime has not reaped yet is a zombie: dead.
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    let stat = String::from_utf8_lossy(&out.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

/// H.264 + AC-3 in Matroska: the picture is copied, the audio becomes AAC,
/// and the MP4 is as long as the source.
#[tokio::test(flavor = "multi_thread")]
async fn a_playable_mkv_is_remuxed_losslessly_into_mp4() {
    let Some(engine) = engine_path() else { return };
    let Some(encoder) = pick_encoder(&engine, Platform::current()).await else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let mkv = dir.path().join("clip.mkv");
    let mut args: Vec<String> = vec!["-pix_fmt".into(), "yuv420p".into()];
    args.extend(encoder.args(500));
    args.extend(["-c:a".into(), "ac3".into()]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    generate(&engine, &mkv, 6, &args);
    let info = probe(&engine, &mkv).await.unwrap();
    assert_eq!(plan::decide(&info, Platform::current()), Decision::Remux { audio: AudioPlan::Encode });

    let out = dir.path().join("out.mp4");
    let mut seen = Vec::new();
    remux::remux(&engine, &mkv, &out, &info, AudioPlan::Encode, |f| seen.push(f))
        .await
        .unwrap();
    assert_eq!(seen.last().copied(), Some(1.0), "progress ends at 100%");
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress only goes up");
    let result = probe(&engine, &out).await.unwrap();
    assert!(result.formats.iter().any(|f| f == "mp4"), "{:?}", result.formats);
    assert_eq!(result.video.as_ref().map(|v| v.codec.as_str()), Some("h264"));
    assert_eq!(result.audio.as_ref().map(|a| a.codec.as_str()), Some("aac"));
    assert!((result.duration.unwrap() - 6.0).abs() < 0.3);
}

#[test]
fn the_engine_name_matches_what_the_bundle_ships() {
    assert_eq!(engine::binary_name(), format!("hippius-ffmpeg{}", std::env::consts::EXE_SUFFIX));
}

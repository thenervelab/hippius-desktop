//! A recording's length, read from its MP4 header.
//!
//! The server counts a Free plan's recordings and refuses one longer than its
//! limit only for an upload whose manifest declares it a recording with a
//! length (`hcfs_shared::network::Capture`); it never sees the plaintext, so
//! the app has to say. Delivery only has the file: a Retry, a recording held
//! for room, or one kept from an earlier run has no recorder session left to
//! ask. So the length is read from the file's own `mvhd` box, which every
//! recorder this app ships writes (AVFoundation, Media Foundation and
//! GStreamer's `mp4mux` all produce ISO base media files).
//!
//! The walk reads box headers and seeks past their bodies, so a long
//! recording costs a few small reads, wherever its `moov` box is (before the
//! media data, or after it when the writer did not move it to the front).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

/// What a capture's manifest declares, for a file about to be delivered:
/// `Some(Recording)` for a video, `None` for anything else.
///
/// A screenshot is not declared: the server stores no kind for one and
/// counts nothing for it. A video whose length cannot be read is still
/// declared a recording, with length 0, and logged: it then counts toward the
/// plan's recordings, and only the server's length check is lost, which the
/// recorder's own Free plan stop (`allowance::FREE_MAX_RECORDING`) already
/// enforces. Leaving it undeclared would lose the count too.
#[must_use]
pub fn capture_for(path: &Path) -> Option<hcfs_shared::network::Capture> {
    let name = path.file_name()?.to_str()?;
    if !super::recording_allowance::is_video_name(name) {
        return None;
    }
    let length = std::fs::File::open(path).ok().and_then(|mut file| mp4_duration(&mut file));
    let duration_ms = length.map_or_else(
        || {
            tracing::warn!("capture: the recording's length could not be read; declared without one");
            0
        },
        |length| u64::try_from(length.as_millis()).unwrap_or(u64::MAX),
    );
    Some(hcfs_shared::network::Capture::Recording { duration_ms })
}

/// The length in an ISO base media file's movie header (`moov` / `mvhd`),
/// or `None` when there is no readable one.
pub fn mp4_duration(file: &mut (impl Read + Seek)) -> Option<Duration> {
    let end = file.seek(SeekFrom::End(0)).ok()?;
    let (moov_start, moov_end) = find_box(file, 0, end, *b"moov")?;
    let (mvhd_start, mvhd_end) = find_box(file, moov_start, moov_end, *b"mvhd")?;
    read_mvhd(file, mvhd_start, mvhd_end)
}

/// The body range of the first box named `name` among the boxes laid end to
/// end in `[start, end)`.
fn find_box(file: &mut (impl Read + Seek), start: u64, end: u64, name: [u8; 4]) -> Option<(u64, u64)> {
    let mut at = start;
    while at.checked_add(8)? <= end {
        file.seek(SeekFrom::Start(at)).ok()?;
        let size = u64::from(read_u32(file)?);
        let kind = read_array::<4>(file)?;
        // ISO/IEC 14496-12 4.2: a size of 1 means a 64-bit size follows the
        // type, and 0 means the box runs to the end of its container.
        let (header, size) = match size {
            0 => (8, end - at),
            1 => (16, read_u64(file)?),
            size => (8, size),
        };
        let box_end = at.checked_add(size)?;
        if size < header || box_end > end {
            return None;
        }
        if kind == name {
            return Some((at + header, box_end));
        }
        at = box_end;
    }
    None
}

/// The length in an `mvhd` body: timescale (units per second) and duration
/// in those units, 32-bit in version 0 and 64-bit in version 1.
fn read_mvhd(file: &mut (impl Read + Seek), start: u64, end: u64) -> Option<Duration> {
    file.seek(SeekFrom::Start(start)).ok()?;
    let version = read_array::<4>(file)?[0];
    let (times, timescale, duration) = match version {
        // Creation and modification times, then timescale and duration.
        0 => {
            read_array::<8>(file)?;
            (8 + 8, read_u32(file)?, u64::from(read_u32(file)?))
        }
        1 => {
            read_array::<16>(file)?;
            (16 + 12, read_u32(file)?, read_u64(file)?)
        }
        _ => return None,
    };
    // The version and flags word, then the fields read above.
    if start + 4 + times > end || timescale == 0 {
        return None;
    }
    // u64::MAX in either width is "unknown" (ISO/IEC 14496-12 8.2.2.3).
    if duration == u64::MAX || (version == 0 && duration == u64::from(u32::MAX)) {
        return None;
    }
    let millis = u128::from(duration) * 1000 / u128::from(timescale);
    Some(Duration::from_millis(u64::try_from(millis).ok()?))
}

fn read_array<const N: usize>(file: &mut impl Read) -> Option<[u8; N]> {
    let mut bytes = [0; N];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

fn read_u32(file: &mut impl Read) -> Option<u32> {
    read_array::<4>(file).map(u32::from_be_bytes)
}

fn read_u64(file: &mut impl Read) -> Option<u64> {
    read_array::<8>(file).map(u64::from_be_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn boxed(kind: [u8; 4], body: &[u8]) -> Vec<u8> {
        let size = u32::try_from(8 + body.len()).unwrap();
        [&size.to_be_bytes()[..], &kind, body].concat()
    }

    fn mvhd_v0(timescale: u32, duration: u32) -> Vec<u8> {
        let body = [&[0u8; 4][..], &[0; 8], &timescale.to_be_bytes(), &duration.to_be_bytes(), &[0; 80]].concat();
        boxed(*b"mvhd", &body)
    }

    fn mvhd_v1(timescale: u32, duration: u64) -> Vec<u8> {
        let body = [&[1u8, 0, 0, 0][..], &[0; 16], &timescale.to_be_bytes(), &duration.to_be_bytes(), &[0; 80]].concat();
        boxed(*b"mvhd", &body)
    }

    fn length(bytes: Vec<u8>) -> Option<Duration> {
        mp4_duration(&mut Cursor::new(bytes))
    }

    #[test]
    fn the_length_is_read_from_a_version_0_header_after_the_media_data() {
        let trak = boxed(*b"trak", &[0; 12]);
        let moov = boxed(*b"moov", &[trak, mvhd_v0(600, 1_500)].concat());
        let file = [boxed(*b"ftyp", b"isom\0\0\0\0"), boxed(*b"mdat", &[7; 64]), moov].concat();
        assert_eq!(length(file), Some(Duration::from_millis(2_500)));
    }

    #[test]
    fn the_length_is_read_from_a_version_1_header_before_the_media_data() {
        let moov = boxed(*b"moov", &mvhd_v1(90_000, 27_000_000));
        let file = [boxed(*b"ftyp", b"isom\0\0\0\0"), moov, boxed(*b"mdat", &[7; 64])].concat();
        assert_eq!(length(file), Some(Duration::from_mins(5)));
    }

    #[test]
    fn a_64_bit_media_box_is_skipped() {
        let mdat = [&1u32.to_be_bytes()[..], b"mdat", &(16u64 + 32).to_be_bytes(), &[7; 32]].concat();
        let file = [mdat, boxed(*b"moov", &mvhd_v0(1_000, 4_200))].concat();
        assert_eq!(length(file), Some(Duration::from_millis(4_200)));
    }

    #[test]
    fn a_file_without_a_readable_header_has_no_length() {
        // No moov at all: a recording cut off before its writer finished.
        assert_eq!(length([boxed(*b"ftyp", b"isom"), boxed(*b"mdat", &[7; 64])].concat()), None);
        // A moov with no mvhd.
        assert_eq!(length(boxed(*b"moov", &boxed(*b"trak", &[0; 8]))), None);
        // A box claiming more bytes than the file has.
        let mut truncated = boxed(*b"moov", &mvhd_v0(600, 600));
        truncated.truncate(30);
        assert_eq!(length(truncated), None);
        // A zero timescale, and the all-ones "unknown" duration.
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(0, 600))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(600, u32::MAX))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v1(600, u64::MAX))), None);
        // Not an MP4.
        assert_eq!(length(b"\x1aE\xdf\xa3 webm".to_vec()), None);
        assert_eq!(length(Vec::new()), None);
    }

    #[test]
    fn a_video_is_declared_a_recording_and_a_picture_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Recording.mp4");
        std::fs::write(&video, boxed(*b"moov", &mvhd_v0(1_000, 61_000))).unwrap();
        assert_eq!(
            capture_for(&video),
            Some(hcfs_shared::network::Capture::Recording { duration_ms: 61_000 })
        );

        let unreadable = dir.path().join("Cut off.mp4");
        std::fs::write(&unreadable, boxed(*b"mdat", &[7; 8])).unwrap();
        assert_eq!(
            capture_for(&unreadable),
            Some(hcfs_shared::network::Capture::Recording { duration_ms: 0 })
        );

        let picture = dir.path().join("Screenshot.png");
        std::fs::write(&picture, b"png").unwrap();
        assert_eq!(capture_for(&picture), None);
    }
}

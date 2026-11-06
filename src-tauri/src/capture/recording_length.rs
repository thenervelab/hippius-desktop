//! A recording's length, read from its MP4 boxes.
//!
//! The server counts a Free plan's recordings and refuses one longer than its
//! limit only for an upload whose manifest declares it a recording with a
//! length (`hcfs_shared::network::Capture`); it never sees the plaintext, so
//! the app has to say. Delivery only has the file: a Retry, a recording held
//! for room, or one kept from an earlier run has no recorder session left to
//! ask. So the length is read from the file.
//!
//! Every recorder this app ships writes a FRAGMENTED MP4, so a recorder that
//! is killed still leaves a playable file: AVFoundation with a
//! `movieFragmentInterval` (macOS), `MFTranscodeContainerType_FMPEG4`
//! (Windows) and `mp4mux fragment-duration=` (Linux). In such a file the
//! movie header (`moov/mvhd`) covers only the samples inside `moov`, usually
//! none, so its duration is 0. The whole length is then the movie extends
//! header (`moov/mvex/mehd`) when the writer filled it in, else the end of
//! the last fragment: each `moof/traf` starts at its `tfdt` decode time and
//! runs for its `trun` sample durations, in the track's `mdhd` timescale
//! (ISO/IEC 14496-12, 8.8). A file without `mvex` is not fragmented, and its
//! `mvhd` duration is the length.
//!
//! The walk reads box headers and seeks past their bodies, so a long
//! recording costs a few small reads per fragment, wherever `moov` is.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

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
    let file = std::fs::File::open(path).ok();
    let duration_ms = file.and_then(|f| mp4_duration_ms(&mut std::io::BufReader::new(f))).unwrap_or_else(|| {
        tracing::warn!("capture: the recording's length could not be read; declared without one");
        0
    });
    Some(hcfs_shared::network::Capture::Recording { duration_ms })
}

/// The length in milliseconds of an ISO base media file, or `None` when it
/// has no readable one (no `moov`, a truncated box, a length under 1 ms).
fn mp4_duration_ms(file: &mut (impl Read + Seek)) -> Option<u64> {
    let file_end = file.seek(SeekFrom::End(0)).ok()?;
    let moov = find_box(file, Span::new(0, file_end), *b"moov")?;
    let mvhd = find_box(file, moov.body, *b"mvhd")?;
    let movie = read_media_header(file, mvhd.body)?;

    let Some(mvex) = find_box(file, moov.body, *b"mvex") else {
        return movie.duration.and_then(|units| millis(units, movie.timescale));
    };
    let extends = find_box(file, mvex.body, *b"mehd").and_then(|mehd| read_wide_or_narrow(file, mehd.body));
    if let Some(units) = extends.filter(|units| *units > 0) {
        return millis(units, movie.timescale);
    }
    fragments_ms(file, moov.body, mvex.body, file_end)
}

/// `units` of `timescale` per second, in milliseconds; `None` under 1 ms or
/// for a zero timescale. Saturates: a length too large to hold is still
/// longer than any plan allows.
fn millis(units: u64, timescale: u32) -> Option<u64> {
    if timescale == 0 {
        return None;
    }
    let ms = u128::from(units) * 1000 / u128::from(timescale);
    Some(u64::try_from(ms).unwrap_or(u64::MAX)).filter(|ms| *ms > 0)
}

/// A byte range of the file, `[start, end)`.
#[derive(Clone, Copy, Debug)]
struct Span {
    start: u64,
    end: u64,
}

impl Span {
    fn new(start: u64, end: u64) -> Self {
        Self { start, end }
    }
}

/// One box: its four-character type and the range of its body.
#[derive(Clone, Copy, Debug)]
struct Mp4Box {
    kind: [u8; 4],
    body: Span,
}

/// The boxes laid end to end in a span, read one header at a time. A box
/// whose size does not fit the span ends the walk.
struct Children {
    at: u64,
    end: u64,
}

impl Children {
    fn of(span: Span) -> Self {
        Self {
            at: span.start,
            end: span.end,
        }
    }

    fn next(&mut self, file: &mut (impl Read + Seek)) -> Option<Mp4Box> {
        let found = self.read(file);
        if found.is_none() {
            self.at = self.end;
        }
        found
    }

    fn read(&mut self, file: &mut (impl Read + Seek)) -> Option<Mp4Box> {
        let at = self.at;
        if at.checked_add(8)? > self.end {
            return None;
        }
        file.seek(SeekFrom::Start(at)).ok()?;
        let size = u64::from(read_u32(file)?);
        let kind = read_array::<4>(file)?;
        // ISO/IEC 14496-12 4.2: a size of 1 means a 64-bit size follows the
        // type, and 0 means the box runs to the end of its container.
        let (header, size) = match size {
            0 => (8, self.end - at),
            1 => (16, read_u64(file)?),
            size => (8, size),
        };
        let box_end = at.checked_add(size)?;
        if size < header || box_end > self.end {
            return None;
        }
        self.at = box_end;
        Some(Mp4Box {
            kind,
            body: Span::new(at + header, box_end),
        })
    }
}

/// The first box named `name` directly inside `span`.
fn find_box(file: &mut (impl Read + Seek), span: Span, name: [u8; 4]) -> Option<Mp4Box> {
    let mut children = Children::of(span);
    while let Some(found) = children.next(file) {
        if found.kind == name {
            return Some(found);
        }
    }
    None
}

/// A movie (`mvhd`) or media (`mdhd`) header: both are version, flags, two
/// times, then the timescale and a duration, 32-bit in version 0 and 64-bit
/// in version 1.
struct MediaHeader {
    timescale: u32,
    /// `None` for the all-ones "unknown" value (ISO/IEC 14496-12 8.2.2.3).
    duration: Option<u64>,
}

fn read_media_header(file: &mut (impl Read + Seek), body: Span) -> Option<MediaHeader> {
    let wide = read_full_box_header(file, body, 4 + 4 + 8)?;
    let (timescale, duration, unknown) = if wide {
        read_array::<16>(file)?;
        (read_u32(file)?, read_u64(file)?, u64::MAX)
    } else {
        read_array::<8>(file)?;
        (read_u32(file)?, u64::from(read_u32(file)?), u64::from(u32::MAX))
    };
    Some(MediaHeader {
        timescale,
        duration: (duration != unknown).then_some(duration),
    })
}

/// A full box whose one field is 32-bit in version 0 and 64-bit in version
/// 1: `mehd`'s fragment duration, `tfdt`'s base media decode time.
fn read_wide_or_narrow(file: &mut (impl Read + Seek), body: Span) -> Option<u64> {
    if read_full_box_header(file, body, 4)? {
        read_u64(file)
    } else {
        read_u32(file).map(u64::from)
    }
}

/// Seek to `body` and read a full box's version and flags. `Some(true)` when
/// the version is 1 (64-bit fields); `None` for another version, or a body
/// shorter than `fields` bytes after the header.
fn read_full_box_header(file: &mut (impl Read + Seek), body: Span, fields: u64) -> Option<bool> {
    file.seek(SeekFrom::Start(body.start)).ok()?;
    let version = read_array::<4>(file)?[0];
    if version > 1 || body.start + 4 + fields > body.end {
        return None;
    }
    Some(version == 1)
}

/// The 24 flag bits of a full box, re-reading its header.
fn read_flags(file: &mut (impl Read + Seek), body: Span) -> Option<u32> {
    file.seek(SeekFrom::Start(body.start)).ok()?;
    Some(read_u32(file)? & 0x00FF_FFFF)
}

/// One track's fragment bookkeeping.
#[derive(Default)]
struct Track {
    timescale: u32,
    /// `trex.default_sample_duration`, for a run whose samples carry none.
    default_duration: u32,
    /// The decode time the last fragment ended at, in `timescale` units.
    end: u64,
}

/// The length of a fragmented file: the latest end of any track's last
/// fragment, in milliseconds.
fn fragments_ms(file: &mut (impl Read + Seek), moov: Span, mvex: Span, file_end: u64) -> Option<u64> {
    let mut tracks = track_timescales(file, moov);
    let mut defaults = Children::of(mvex);
    while let Some(trex) = defaults.next(file) {
        if trex.kind == *b"trex"
            && let Some((id, duration)) = read_trex(file, trex.body)
            && let Some(track) = tracks.get_mut(&id)
        {
            track.default_duration = duration;
        }
    }

    let mut top = Children::of(Span::new(0, file_end));
    while let Some(moof) = top.next(file) {
        if moof.kind != *b"moof" {
            continue;
        }
        let mut trafs = Children::of(moof.body);
        while let Some(traf) = trafs.next(file) {
            if traf.kind == *b"traf" {
                read_traf(file, traf.body, &mut tracks);
            }
        }
    }
    tracks.values().filter_map(|track| millis(track.end, track.timescale)).max()
}

/// Each `trak`'s id (`tkhd`) and timescale (`mdia/mdhd`).
fn track_timescales(file: &mut (impl Read + Seek), moov: Span) -> HashMap<u32, Track> {
    let mut tracks = HashMap::new();
    let mut traks = Children::of(moov);
    while let Some(trak) = traks.next(file) {
        if trak.kind != *b"trak" {
            continue;
        }
        let id = find_box(file, trak.body, *b"tkhd").and_then(|tkhd| read_track_id(file, tkhd.body));
        let timescale = find_box(file, trak.body, *b"mdia")
            .and_then(|mdia| find_box(file, mdia.body, *b"mdhd"))
            .and_then(|mdhd| read_media_header(file, mdhd.body))
            .map(|header| header.timescale);
        if let (Some(id), Some(timescale)) = (id, timescale) {
            tracks.insert(
                id,
                Track {
                    timescale,
                    ..Track::default()
                },
            );
        }
    }
    tracks
}

/// `tkhd`'s track id: after two times, 32-bit in version 0, 64-bit in 1.
fn read_track_id(file: &mut (impl Read + Seek), body: Span) -> Option<u32> {
    if read_full_box_header(file, body, 4 + 8)? {
        read_array::<16>(file)?;
    } else {
        read_array::<8>(file)?;
    }
    read_u32(file)
}

/// `trex`: track id, sample description index, default sample duration.
fn read_trex(file: &mut (impl Read + Seek), body: Span) -> Option<(u32, u32)> {
    read_full_box_header(file, body, 12)?;
    let id = read_u32(file)?;
    read_u32(file)?;
    Some((id, read_u32(file)?))
}

/// `tfhd` flags (ISO/IEC 14496-12 8.8.7.1).
const TFHD_BASE_DATA_OFFSET: u32 = 0x01;
const TFHD_SAMPLE_DESCRIPTION_INDEX: u32 = 0x02;
const TFHD_DEFAULT_SAMPLE_DURATION: u32 = 0x08;

/// `trun` flags (ISO/IEC 14496-12 8.8.8.1).
const TRUN_DATA_OFFSET: u32 = 0x01;
const TRUN_FIRST_SAMPLE_FLAGS: u32 = 0x04;
const TRUN_SAMPLE_DURATION: u32 = 0x100;
const TRUN_SAMPLE_SIZE: u32 = 0x200;
const TRUN_SAMPLE_FLAGS: u32 = 0x400;
const TRUN_SAMPLE_COMPOSITION_OFFSET: u32 = 0x800;

/// Move one track fragment's end forward: from its `tfdt` decode time (or
/// where the track's last fragment ended, when it has none) by the sum of
/// its runs' sample durations. A fragment for a track `moov` does not
/// describe is skipped; a malformed one leaves the track where it was.
fn read_traf(file: &mut (impl Read + Seek), traf: Span, tracks: &mut HashMap<u32, Track>) {
    let Some((id, tfhd_default)) = find_box(file, traf, *b"tfhd").and_then(|tfhd| read_tfhd(file, tfhd.body)) else {
        return;
    };
    let Some(track) = tracks.get_mut(&id) else { return };
    let default = tfhd_default.unwrap_or(track.default_duration);
    let start = find_box(file, traf, *b"tfdt")
        .and_then(|tfdt| read_wide_or_narrow(file, tfdt.body))
        .unwrap_or(track.end);

    let mut runs = Children::of(traf);
    let mut length: u64 = 0;
    while let Some(trun) = runs.next(file) {
        if trun.kind == *b"trun" {
            let Some(run) = read_trun_duration(file, trun.body, default) else {
                return;
            };
            length = length.saturating_add(run);
        }
    }
    track.end = start.saturating_add(length);
}

/// `tfhd`'s track id and its default sample duration, when it has one.
fn read_tfhd(file: &mut (impl Read + Seek), body: Span) -> Option<(u32, Option<u32>)> {
    read_full_box_header(file, body, 4)?;
    let flags = read_flags(file, body)?;
    let id = read_u32(file)?;
    if flags & TFHD_BASE_DATA_OFFSET != 0 {
        read_u64(file)?;
    }
    if flags & TFHD_SAMPLE_DESCRIPTION_INDEX != 0 {
        read_u32(file)?;
    }
    let default = if flags & TFHD_DEFAULT_SAMPLE_DURATION != 0 {
        Some(read_u32(file)?)
    } else {
        None
    };
    Some((id, default))
}

/// The sum of a `trun`'s sample durations: each sample's own when the run
/// carries them, else `default` for every sample. `None` when the run claims
/// more samples than its box holds.
fn read_trun_duration(file: &mut (impl Read + Seek), body: Span, default: u32) -> Option<u64> {
    read_full_box_header(file, body, 4)?;
    let flags = read_flags(file, body)?;
    let count = read_u32(file)?;
    let mut fixed = 8;
    for flag in [TRUN_DATA_OFFSET, TRUN_FIRST_SAMPLE_FLAGS] {
        if flags & flag != 0 {
            read_u32(file)?;
            fixed += 4;
        }
    }
    if flags & TRUN_SAMPLE_DURATION == 0 {
        return Some(u64::from(count) * u64::from(default));
    }
    // Every per-sample field is 32 bits; the duration comes first.
    let fields: u64 = [TRUN_SAMPLE_SIZE, TRUN_SAMPLE_FLAGS, TRUN_SAMPLE_COMPOSITION_OFFSET]
        .iter()
        .map(|flag| u64::from(flags & flag != 0))
        .sum::<u64>()
        + 1;
    // Checked before reading, so a hostile count cannot make the loop read
    // past the box: every sample's fields must fit in it.
    if body.start + fixed + u64::from(count) * fields * 4 > body.end {
        return None;
    }
    let mut total: u64 = 0;
    for _ in 0..count {
        total = total.saturating_add(u64::from(read_u32(file)?));
        for _ in 1..fields {
            read_u32(file)?;
        }
    }
    Some(total)
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

    /// A full box: version, 24-bit flags, then `fields`.
    fn full(kind: [u8; 4], version: u8, flags: u32, fields: &[u8]) -> Vec<u8> {
        let head = (u32::from(version) << 24) | flags;
        boxed(kind, &[&head.to_be_bytes()[..], fields].concat())
    }

    fn be32(v: u32) -> [u8; 4] {
        v.to_be_bytes()
    }

    fn mvhd_v0(timescale: u32, duration: u32) -> Vec<u8> {
        full(*b"mvhd", 0, 0, &[&[0; 8][..], &be32(timescale), &be32(duration), &[0; 80]].concat())
    }

    fn mvhd_v1(timescale: u32, duration: u64) -> Vec<u8> {
        full(
            *b"mvhd",
            1,
            0,
            &[&[0; 16][..], &be32(timescale), &duration.to_be_bytes(), &[0; 80]].concat(),
        )
    }

    fn trak(id: u32, timescale: u32) -> Vec<u8> {
        let tkhd = full(*b"tkhd", 0, 0, &[&[0; 8][..], &be32(id), &[0; 68]].concat());
        let mdhd = full(*b"mdhd", 0, 0, &[&[0; 8][..], &be32(timescale), &be32(0), &[0; 4]].concat());
        boxed(*b"trak", &[tkhd, boxed(*b"mdia", &mdhd)].concat())
    }

    fn trex(id: u32, default_duration: u32) -> Vec<u8> {
        full(*b"trex", 0, 0, &[be32(id), be32(1), be32(default_duration), be32(0), be32(0)].concat())
    }

    /// A fragment of track `id` starting at `tfdt`, whose samples carry
    /// their own durations (and a size each, as encoders write them).
    fn moof(id: u32, tfdt: Option<u64>, durations: &[u32]) -> Vec<u8> {
        let tfhd = full(*b"tfhd", 0, 0, &be32(id));
        let tfdt = tfdt.map(|t| full(*b"tfdt", 1, 0, &t.to_be_bytes())).unwrap_or_default();
        let samples: Vec<u8> = durations.iter().flat_map(|d| [be32(*d), be32(100)].concat()).collect();
        let count = u32::try_from(durations.len()).unwrap();
        let flags = TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE;
        let trun = full(*b"trun", 0, flags, &[&be32(count)[..], &be32(0), &samples].concat());
        boxed(*b"moof", &boxed(*b"traf", &[tfhd, tfdt, trun].concat()))
    }

    fn length(bytes: Vec<u8>) -> Option<u64> {
        mp4_duration_ms(&mut Cursor::new(bytes))
    }

    #[test]
    fn a_plain_file_s_length_is_its_movie_header_s_wherever_moov_is() {
        let moov = boxed(*b"moov", &[trak(1, 600), mvhd_v0(600, 1_500)].concat());
        let after = [boxed(*b"ftyp", b"isom\0\0\0\0"), boxed(*b"mdat", &[7; 64]), moov].concat();
        assert_eq!(length(after), Some(2_500));

        let moov = boxed(*b"moov", &mvhd_v1(90_000, 27_000_000));
        let before = [boxed(*b"ftyp", b"isom\0\0\0\0"), moov, boxed(*b"mdat", &[7; 64])].concat();
        assert_eq!(length(before), Some(300_000));
    }

    #[test]
    fn a_64_bit_media_box_is_skipped() {
        let mdat = [&1u32.to_be_bytes()[..], b"mdat", &(16u64 + 32).to_be_bytes(), &[7; 32]].concat();
        let file = [mdat, boxed(*b"moov", &mvhd_v0(1_000, 4_200))].concat();
        assert_eq!(length(file), Some(4_200));
    }

    /// What the recorders write: an empty movie header, and the length in
    /// the movie extends header when the writer filled it in.
    #[test]
    fn a_fragmented_file_s_length_is_its_extends_header_s() {
        let mehd = full(*b"mehd", 0, 0, &be32(300_000));
        let mvex = boxed(*b"mvex", &[mehd, trex(1, 0)].concat());
        let moov = boxed(*b"moov", &[mvhd_v0(1_000, 0), trak(1, 90_000), mvex].concat());
        let file = [moov, moof(1, Some(0), &[3_000; 10]), boxed(*b"mdat", &[7; 16])].concat();
        assert_eq!(length(file), Some(300_000));
    }

    /// Without `mehd` (or with it 0), the length is where the last fragment
    /// of the longest track ends. Two tracks with their own timescales, and
    /// a fragment with no `tfdt` that follows on from the one before it.
    #[test]
    fn a_fragmented_file_without_an_extends_header_ends_with_its_last_fragment() {
        let mvex = boxed(*b"mvex", &[full(*b"mehd", 0, 0, &be32(0)), trex(1, 0), trex(2, 0)].concat());
        let moov = boxed(*b"moov", &[mvhd_v0(1_000, 0), trak(1, 90_000), trak(2, 48_000), mvex].concat());
        let file = [
            moov,
            // Video: 2 s from 0, then 2 s more with no tfdt.
            moof(1, Some(0), &[3_000; 60]),
            boxed(*b"mdat", &[7; 16]),
            moof(1, None, &[3_000; 60]),
            boxed(*b"mdat", &[7; 16]),
            // Audio: 211 samples of 1024 from 1 s.
            moof(2, Some(48_000), &[1_024; 211]),
            boxed(*b"mdat", &[7; 16]),
        ]
        .concat();
        // Audio ends at (48000 + 211 * 1024) / 48000 s = 5501 ms, after the
        // video's 4000 ms.
        assert_eq!(length(file), Some(5_501));
    }

    /// A run whose samples carry no duration uses the fragment's default,
    /// else the track's `trex` default.
    #[test]
    fn samples_without_a_duration_take_the_default() {
        let mvex = boxed(*b"mvex", &trex(1, 1_500));
        let moov = boxed(*b"moov", &[mvhd_v0(1_000, 0), trak(1, 30_000), mvex].concat());
        let tfhd = full(*b"tfhd", 0, 0, &be32(1));
        let trun = full(*b"trun", 0, 0, &be32(40));
        let fragment = boxed(*b"moof", &boxed(*b"traf", &[tfhd, trun].concat()));
        assert_eq!(length([moov.clone(), fragment].concat()), Some(2_000));

        let tfhd = full(*b"tfhd", 0, TFHD_DEFAULT_SAMPLE_DURATION, &[be32(1), be32(3_000)].concat());
        let trun = full(*b"trun", 0, 0, &be32(40));
        let fragment = boxed(*b"moof", &boxed(*b"traf", &[tfhd, trun].concat()));
        assert_eq!(length([moov, fragment].concat()), Some(4_000));
    }

    #[test]
    fn a_file_without_a_readable_length_has_none() {
        // No moov: a recording cut off before its writer started.
        assert_eq!(length([boxed(*b"ftyp", b"isom"), boxed(*b"mdat", &[7; 64])].concat()), None);
        // A moov with no mvhd.
        assert_eq!(length(boxed(*b"moov", &trak(1, 600))), None);
        // A box claiming more bytes than the file has.
        let mut truncated = boxed(*b"moov", &mvhd_v0(600, 600));
        truncated.truncate(30);
        assert_eq!(length(truncated), None);
        // A zero timescale, a zero length, and the all-ones "unknown".
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(0, 600))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(600, 0))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(600, u32::MAX))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v1(600, u64::MAX))), None);
        // Fragmented, with no fragment yet.
        let moov = boxed(*b"moov", &[mvhd_v0(1_000, 0), trak(1, 600), boxed(*b"mvex", &trex(1, 0))].concat());
        assert_eq!(length(moov), None);
        // Not an MP4.
        assert_eq!(length(b"\x1aE\xdf\xa3 webm".to_vec()), None);
        assert_eq!(length(Vec::new()), None);
    }

    /// A run claiming more samples than its box holds is refused rather than
    /// read past its end.
    #[test]
    fn a_run_claiming_more_samples_than_it_holds_is_not_counted() {
        let mvex = boxed(*b"mvex", &trex(1, 0));
        let moov = boxed(*b"moov", &[mvhd_v0(1_000, 0), trak(1, 1_000), mvex].concat());
        let tfhd = full(*b"tfhd", 0, 0, &be32(1));
        let trun = full(*b"trun", 0, TRUN_SAMPLE_DURATION, &[be32(u32::MAX), be32(1_000)].concat());
        let fragment = boxed(*b"moof", &boxed(*b"traf", &[tfhd, trun].concat()));
        assert_eq!(length([moov, fragment].concat()), None);
    }

    /// A length too long to hold in milliseconds still reads as too long.
    #[test]
    fn a_huge_length_saturates() {
        assert_eq!(length(boxed(*b"moov", &mvhd_v1(1, u64::MAX - 1))), Some(u64::MAX));
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

    proptest::proptest! {
        /// No file, however malformed, panics or loops forever.
        #[test]
        fn any_bytes_are_read_without_panicking(bytes in proptest::collection::vec(proptest::num::u8::ANY, 0..512)) {
            let _ = length(bytes);
        }

        /// A plain file's header length round-trips, in either version.
        #[test]
        fn a_movie_header_round_trips(timescale in 1u32.., units in 1u32..u32::MAX, wide in proptest::bool::ANY) {
            let mvhd = if wide { mvhd_v1(timescale, u64::from(units)) } else { mvhd_v0(timescale, units) };
            let ms = u64::from(units) * 1000 / u64::from(timescale);
            proptest::prop_assert_eq!(length(boxed(*b"moov", &mvhd)), Some(ms).filter(|ms| *ms > 0));
        }
    }
}

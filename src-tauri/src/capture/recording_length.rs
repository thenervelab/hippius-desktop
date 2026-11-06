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
//! none, so its duration is often 0. The movie extends header
//! (`moov/mvex/mehd`) has the whole length when the writer filled it in, and
//! the fragments have it always: each `moof/traf` starts at its `tfdt`
//! decode time and runs for its `trun` sample durations, in the track's
//! `mdhd` timescale (ISO/IEC 14496-12, 8.8). The length is the longest of
//! the three, because each source only ever falls short: a writer that
//! rewrites the file at the end (macOS `shouldOptimizeForNetworkUse`) may
//! fill `mvhd` and leave `mvex` with no fragments behind it.
//!
//! Only box headers are read at the top level, seeking past each body. The
//! `moov` and each `moof` are read whole, up to [`MAX_BOX_READ`], and parsed
//! from memory, so every field read is bounded by its box.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Largest `moov` or `moof` read into memory. Arbitrary, far above what a
/// recording needs: a fragmented recording's `moov` holds no sample tables
/// and a two-second `moof` a few hundred samples, and even a two-hour
/// unfragmented `moov` is a few MB. A larger box is not read, so a crafted
/// file cannot make the app allocate its size.
const MAX_BOX_READ: u64 = 64 * 1024 * 1024;

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
    let duration_ms = file.and_then(|mut f| mp4_duration_ms(&mut f)).unwrap_or_else(|| {
        tracing::warn!("capture: the recording's length could not be read; declared without one");
        0
    });
    Some(hcfs_shared::network::Capture::Recording { duration_ms })
}

/// The length in milliseconds of an ISO base media file, or `None` when it
/// has no readable one (no `moov`, a truncated box, a length under 1 ms).
fn mp4_duration_ms(file: &mut (impl Read + Seek)) -> Option<u64> {
    let file_end = file.seek(SeekFrom::End(0)).ok()?;
    let moov_box = find_top(file, file_end, *b"moov")?;
    let moov = read_body(file, moov_box)?;
    let movie = media_header(find(&moov, *b"mvhd")?)?;
    let header = movie.duration.and_then(|units| millis(units, movie.timescale));

    let Some(mvex) = find(&moov, *b"mvex") else {
        return header;
    };
    let extends = find(mvex, *b"mehd")
        .and_then(wide_or_narrow)
        .and_then(|units| millis(units, movie.timescale));
    let fragments = fragments_ms(file, file_end, &moov, mvex);
    [header, extends, fragments].into_iter().flatten().max()
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

// ── Top-level boxes, in the file ─────────────────────────────────────────────

/// A box directly in the file: its type and where its body is.
#[derive(Clone, Copy, Debug)]
struct TopBox {
    kind: [u8; 4],
    body_start: u64,
    end: u64,
}

/// The box whose header starts at `at`, or `None` at the end of the file or
/// for a header that does not fit it.
fn top_box(file: &mut (impl Read + Seek), at: u64, file_end: u64) -> Option<TopBox> {
    if at.checked_add(8)? > file_end {
        return None;
    }
    file.seek(SeekFrom::Start(at)).ok()?;
    let mut head = [0; 8];
    file.read_exact(&mut head).ok()?;
    let (size, kind) = head.split_at(4);
    let kind: [u8; 4] = kind.try_into().ok()?;
    // ISO/IEC 14496-12 4.2: a size of 1 means a 64-bit size follows the
    // type, and 0 means the box runs to the end of the file.
    let (header, size) = match u32::from_be_bytes(size.try_into().ok()?) {
        0 => (8, file_end - at),
        1 => {
            let mut large = [0; 8];
            file.read_exact(&mut large).ok()?;
            (16, u64::from_be_bytes(large))
        }
        size => (8, u64::from(size)),
    };
    let end = at.checked_add(size)?;
    (size >= header && end <= file_end).then_some(TopBox {
        kind,
        body_start: at + header,
        end,
    })
}

/// The first top-level box named `name`.
fn find_top(file: &mut (impl Read + Seek), file_end: u64, name: [u8; 4]) -> Option<TopBox> {
    let mut at = 0;
    while let Some(found) = top_box(file, at, file_end) {
        if found.kind == name {
            return Some(found);
        }
        at = found.end;
    }
    None
}

/// A top-level box's body, or `None` past [`MAX_BOX_READ`].
fn read_body(file: &mut (impl Read + Seek), found: TopBox) -> Option<Vec<u8>> {
    let len = found.end - found.body_start;
    if len > MAX_BOX_READ {
        return None;
    }
    file.seek(SeekFrom::Start(found.body_start)).ok()?;
    let mut body = vec![0; usize::try_from(len).ok()?];
    file.read_exact(&mut body).ok()?;
    Some(body)
}

// ── Boxes inside a box, in memory ────────────────────────────────────────────

/// The boxes laid end to end in `bytes`, as `(type, body)`. A box whose size
/// does not fit ends the walk.
fn children(mut bytes: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        let mut fields = Fields(bytes);
        let size = fields.u32()?;
        let kind = fields.array::<4>()?;
        let (header, size) = match size {
            0 => (8, bytes.len()),
            1 => (16, usize::try_from(fields.u64()?).ok()?),
            size => (8, usize::try_from(size).ok()?),
        };
        if size < header || size > bytes.len() {
            bytes = &[];
            return None;
        }
        let (whole, rest) = bytes.split_at(size);
        bytes = rest;
        Some((kind, &whole[header..]))
    })
}

/// The body of the first box named `name` directly in `bytes`.
fn find(bytes: &[u8], name: [u8; 4]) -> Option<&[u8]> {
    children(bytes).find(|(kind, _)| *kind == name).map(|(_, body)| body)
}

/// A cursor over a box body. Every read is bounded by the body: one past its
/// end is `None`.
struct Fields<'a>(&'a [u8]);

impl Fields<'_> {
    fn array<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>()?;
        self.0 = rest;
        Some(*head)
    }

    fn u32(&mut self) -> Option<u32> {
        self.array().map(u32::from_be_bytes)
    }

    fn u64(&mut self) -> Option<u64> {
        self.array().map(u64::from_be_bytes)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.0 = self.0.get(n..)?;
        Some(())
    }
}

/// A full box's header: whether it is version 1 (64-bit fields), its 24 flag
/// bits, and a cursor after them. `None` for another version.
fn full_box(body: &[u8]) -> Option<(bool, u32, Fields<'_>)> {
    let mut fields = Fields(body);
    let head = fields.u32()?;
    let version = head >> 24;
    (version <= 1).then_some((version == 1, head & 0x00FF_FFFF, fields))
}

/// A movie (`mvhd`) or media (`mdhd`) header: both are version, flags, two
/// times, then the timescale and a duration, 32-bit in version 0 and 64-bit
/// in version 1.
struct MediaHeader {
    timescale: u32,
    /// `None` for the all-ones "unknown" value (ISO/IEC 14496-12 8.2.2.3).
    duration: Option<u64>,
}

fn media_header(body: &[u8]) -> Option<MediaHeader> {
    let (wide, _, mut fields) = full_box(body)?;
    let (timescale, duration, unknown) = if wide {
        fields.skip(16)?;
        (fields.u32()?, fields.u64()?, u64::MAX)
    } else {
        fields.skip(8)?;
        (fields.u32()?, u64::from(fields.u32()?), u64::from(u32::MAX))
    };
    Some(MediaHeader {
        timescale,
        duration: (duration != unknown).then_some(duration),
    })
}

/// A full box whose one field is 32-bit in version 0 and 64-bit in version
/// 1: `mehd`'s fragment duration, `tfdt`'s base media decode time.
fn wide_or_narrow(body: &[u8]) -> Option<u64> {
    let (wide, _, mut fields) = full_box(body)?;
    if wide { fields.u64() } else { fields.u32().map(u64::from) }
}

// ── Fragments ────────────────────────────────────────────────────────────────

/// One track's fragment bookkeeping.
#[derive(Default)]
struct Track {
    timescale: u32,
    /// `trex.default_sample_duration`, for a run whose samples carry none.
    default_duration: u32,
    /// The decode time the last fragment ended at, in `timescale` units.
    end: u64,
}

/// The length the fragments reach: the latest end of any track's last
/// fragment, in milliseconds.
fn fragments_ms(file: &mut (impl Read + Seek), file_end: u64, moov: &[u8], mvex: &[u8]) -> Option<u64> {
    let mut tracks = tracks(moov, mvex);
    let mut at = 0;
    while let Some(found) = top_box(file, at, file_end) {
        at = found.end;
        if found.kind != *b"moof" {
            continue;
        }
        let Some(moof) = read_body(file, found) else { continue };
        for (kind, traf) in children(&moof) {
            if kind == *b"traf" {
                read_traf(traf, &mut tracks);
            }
        }
    }
    tracks.values().filter_map(|track| millis(track.end, track.timescale)).max()
}

/// Each `trak`'s id (`tkhd`) and timescale (`mdia/mdhd`), with its `trex`
/// default sample duration.
fn tracks(moov: &[u8], mvex: &[u8]) -> HashMap<u32, Track> {
    let mut tracks = HashMap::new();
    for (kind, trak) in children(moov) {
        if kind != *b"trak" {
            continue;
        }
        let id = find(trak, *b"tkhd").and_then(track_id);
        let timescale = find(trak, *b"mdia")
            .and_then(|mdia| find(mdia, *b"mdhd"))
            .and_then(media_header)
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
    for (kind, trex) in children(mvex) {
        if kind == *b"trex"
            && let Some((id, duration)) = trex_default(trex)
            && let Some(track) = tracks.get_mut(&id)
        {
            track.default_duration = duration;
        }
    }
    tracks
}

/// `tkhd`'s track id: after two times, 32-bit in version 0, 64-bit in 1.
fn track_id(body: &[u8]) -> Option<u32> {
    let (wide, _, mut fields) = full_box(body)?;
    fields.skip(if wide { 16 } else { 8 })?;
    fields.u32()
}

/// `trex`: track id, sample description index, default sample duration.
fn trex_default(body: &[u8]) -> Option<(u32, u32)> {
    let (_, _, mut fields) = full_box(body)?;
    let id = fields.u32()?;
    fields.skip(4)?;
    Some((id, fields.u32()?))
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
fn read_traf(traf: &[u8], tracks: &mut HashMap<u32, Track>) {
    let Some((id, tfhd_default)) = find(traf, *b"tfhd").and_then(tfhd) else {
        return;
    };
    let Some(track) = tracks.get_mut(&id) else { return };
    let default = tfhd_default.unwrap_or(track.default_duration);
    let start = find(traf, *b"tfdt").and_then(wide_or_narrow).unwrap_or(track.end);

    let mut length: u64 = 0;
    for (kind, trun) in children(traf) {
        if kind == *b"trun" {
            let Some(run) = trun_duration(trun, default) else { return };
            length = length.saturating_add(run);
        }
    }
    track.end = start.saturating_add(length);
}

/// `tfhd`'s track id and its default sample duration, when it has one.
fn tfhd(body: &[u8]) -> Option<(u32, Option<u32>)> {
    let (_, flags, mut fields) = full_box(body)?;
    let id = fields.u32()?;
    if flags & TFHD_BASE_DATA_OFFSET != 0 {
        fields.skip(8)?;
    }
    if flags & TFHD_SAMPLE_DESCRIPTION_INDEX != 0 {
        fields.skip(4)?;
    }
    let default = if flags & TFHD_DEFAULT_SAMPLE_DURATION != 0 {
        Some(fields.u32()?)
    } else {
        None
    };
    Some((id, default))
}

/// The sum of a `trun`'s sample durations: each sample's own when the run
/// carries them, else `default` for every sample. `None` when the run claims
/// more samples than its box holds.
fn trun_duration(body: &[u8], default: u32) -> Option<u64> {
    let (_, flags, mut fields) = full_box(body)?;
    let count = fields.u32()?;
    for flag in [TRUN_DATA_OFFSET, TRUN_FIRST_SAMPLE_FLAGS] {
        if flags & flag != 0 {
            fields.skip(4)?;
        }
    }
    if flags & TRUN_SAMPLE_DURATION == 0 {
        return Some(u64::from(count) * u64::from(default));
    }
    // Every per-sample field is 32 bits, the duration first.
    let others = [TRUN_SAMPLE_SIZE, TRUN_SAMPLE_FLAGS, TRUN_SAMPLE_COMPOSITION_OFFSET]
        .iter()
        .filter(|flag| flags & **flag != 0)
        .count();
    let stride = 4 * (1 + others);
    let table = fields.0.get(..usize::try_from(count).ok()?.checked_mul(stride)?)?;
    Some(
        table
            .chunks_exact(stride)
            .filter_map(|sample| sample.first_chunk::<4>())
            .map(|duration| u64::from(u32::from_be_bytes(*duration)))
            .fold(0, u64::saturating_add),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn boxed(kind: [u8; 4], body: &[u8]) -> Vec<u8> {
        let size = u32::try_from(8 + body.len()).unwrap();
        [&size.to_be_bytes()[..], &kind, body].concat()
    }

    /// A box with a 64-bit size.
    fn boxed_large(kind: [u8; 4], body: &[u8]) -> Vec<u8> {
        let size = 16 + body.len() as u64;
        [&1u32.to_be_bytes()[..], &kind, &size.to_be_bytes(), body].concat()
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

    /// `trak` with version 1 `tkhd` and `mdhd`.
    fn trak_v1(id: u32, timescale: u32) -> Vec<u8> {
        let tkhd = full(*b"tkhd", 1, 0, &[&[0; 16][..], &be32(id), &[0; 80]].concat());
        let mdhd = full(*b"mdhd", 1, 0, &[&[0; 16][..], &be32(timescale), &0u64.to_be_bytes(), &[0; 4]].concat());
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

    /// A fragmented file's `moov`: an empty movie header, one track.
    fn fragmented_moov(id: u32, timescale: u32, mvex: &[Vec<u8>]) -> Vec<u8> {
        boxed(
            *b"moov",
            &[mvhd_v0(1_000, 0), trak(id, timescale), boxed(*b"mvex", &mvex.concat())].concat(),
        )
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

    /// 64-bit sizes, at the top level (a large `mdat`, a `moof`) and inside.
    #[test]
    fn boxes_with_64_bit_sizes_are_read() {
        let mdat = boxed_large(*b"mdat", &[7; 32]);
        let file = [mdat.clone(), boxed(*b"moov", &mvhd_v0(1_000, 4_200))].concat();
        assert_eq!(length(file), Some(4_200));

        let fragment = moof(1, Some(0), &[1_000; 3]);
        let large_moof = boxed_large(*b"moof", &fragment[8..]);
        let file = [fragmented_moov(1, 1_000, &[trex(1, 0)]), large_moof, mdat].concat();
        assert_eq!(length(file), Some(3_000));
    }

    /// What the recorders write: an empty movie header, and the length in
    /// the movie extends header when the writer filled it in, in either
    /// version.
    #[test]
    fn a_fragmented_file_s_length_is_its_extends_header_s() {
        for mehd in [full(*b"mehd", 0, 0, &be32(300_000)), full(*b"mehd", 1, 0, &300_000u64.to_be_bytes())] {
            let moov = fragmented_moov(1, 90_000, &[mehd, trex(1, 0)]);
            let file = [moov, moof(1, Some(0), &[3_000; 10]), boxed(*b"mdat", &[7; 16])].concat();
            assert_eq!(length(file), Some(300_000));
        }
    }

    /// Without `mehd` (or with it 0), the length is where the
    /// last fragment of the longest track ends. Two tracks with their own
    /// timescales (one with version 1 headers), and a fragment with no
    /// `tfdt` that follows on from the one before it.
    #[test]
    fn a_fragmented_file_without_an_extends_header_ends_with_its_last_fragment() {
        for mehd in [Vec::new(), full(*b"mehd", 0, 0, &be32(0))] {
            let mvex = boxed(*b"mvex", &[mehd, trex(1, 0), trex(2, 0)].concat());
            let moov = boxed(*b"moov", &[mvhd_v0(1_000, 0), trak(1, 90_000), trak_v1(2, 48_000), mvex].concat());
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
            // Audio ends at (48000 + 211 * 1024) / 48000 s = 5501 ms, after
            // the video's 4000 ms.
            assert_eq!(length(file), Some(5_501));
        }
    }

    /// A file rewritten at the end (macOS optimizes for network use) can keep
    /// `mvex` with its fragments gone: the movie header then has the length.
    /// And a recorder killed mid-write leaves its last `mdat` cut short: the
    /// fragments before it still count.
    #[test]
    fn the_longest_source_wins() {
        let rewritten = boxed(*b"moov", &[mvhd_v0(1_000, 61_000), trak(1, 600), boxed(*b"mvex", &trex(1, 0))].concat());
        assert_eq!(length(rewritten), Some(61_000));

        let mut killed = [
            fragmented_moov(1, 1_000, &[trex(1, 0)]),
            moof(1, Some(0), &[500; 4]),
            boxed(*b"mdat", &[7; 64]),
        ]
        .concat();
        killed.truncate(killed.len() - 40);
        assert_eq!(length(killed), Some(2_000));
    }

    /// Every optional `tfhd` and `trun` field is stepped over, in the
    /// standard's order, so the duration read is the duration.
    #[test]
    fn optional_fragment_fields_are_skipped() {
        let tfhd_flags = TFHD_BASE_DATA_OFFSET | TFHD_SAMPLE_DESCRIPTION_INDEX;
        let tfhd = full(*b"tfhd", 0, tfhd_flags, &[&be32(1)[..], &u64::MAX.to_be_bytes(), &be32(9)].concat());
        let trun_flags =
            TRUN_DATA_OFFSET | TRUN_FIRST_SAMPLE_FLAGS | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS | TRUN_SAMPLE_COMPOSITION_OFFSET;
        // Two samples of 1500 units, every other field a large decoy.
        let sample = [be32(1_500), be32(u32::MAX), be32(u32::MAX), be32(u32::MAX)].concat();
        let trun = full(
            *b"trun",
            0,
            trun_flags,
            &[&be32(2)[..], &be32(u32::MAX), &be32(u32::MAX), &sample, &sample].concat(),
        );
        let fragment = boxed(*b"moof", &boxed(*b"traf", &[tfhd, trun].concat()));
        let file = [fragmented_moov(1, 1_000, &[trex(1, 0)]), fragment].concat();
        assert_eq!(length(file), Some(3_000));
    }

    /// A run whose samples carry no duration uses the fragment's default,
    /// else the track's `trex` default.
    #[test]
    fn samples_without_a_duration_take_the_default() {
        let moov = fragmented_moov(1, 30_000, &[trex(1, 1_500)]);
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
        // A version 1 header too short for its 64-bit fields.
        assert_eq!(length(boxed(*b"moov", &full(*b"mvhd", 1, 0, &[0; 20]))), None);
        // A zero timescale, a zero length, and the all-ones "unknown".
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(0, 600))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(600, 0))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v0(600, u32::MAX))), None);
        assert_eq!(length(boxed(*b"moov", &mvhd_v1(600, u64::MAX))), None);
        // Fragmented, with no fragment yet.
        assert_eq!(length(fragmented_moov(1, 600, &[trex(1, 0)])), None);
        // Not an MP4.
        assert_eq!(length(b"\x1aE\xdf\xa3 webm".to_vec()), None);
        assert_eq!(length(Vec::new()), None);
    }

    /// A run claiming more samples than its box holds is refused rather than
    /// read past its end.
    #[test]
    fn a_run_claiming_more_samples_than_it_holds_is_not_counted() {
        let tfhd = full(*b"tfhd", 0, 0, &be32(1));
        let trun = full(*b"trun", 0, TRUN_SAMPLE_DURATION, &[be32(u32::MAX), be32(1_000)].concat());
        let fragment = boxed(*b"moof", &boxed(*b"traf", &[tfhd, trun].concat()));
        assert_eq!(length([fragmented_moov(1, 1_000, &[trex(1, 0)]), fragment].concat()), None);
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
        let file = [fragmented_moov(1, 1_000, &[trex(1, 0)]), moof(1, Some(0), &[61_000])].concat();
        std::fs::write(&video, file).unwrap();
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
        /// No file, however malformed, panics or loops forever: random bytes,
        /// and a valid fragmented file with one byte changed, which reaches
        /// the fragment path random bytes almost never form.
        #[test]
        fn any_bytes_are_read_without_panicking(
            bytes in proptest::collection::vec(proptest::num::u8::ANY, 0..512),
            at in proptest::num::usize::ANY,
            to in proptest::num::u8::ANY,
        ) {
            let _ = length(bytes);
            let mut file = [fragmented_moov(1, 1_000, &[trex(1, 7)]), moof(1, Some(5), &[300; 3]), boxed(*b"mdat", &[7; 8])].concat();
            let at = at % file.len();
            file[at] = to;
            let _ = length(file);
        }

        /// A plain file's header length round-trips, in either version.
        #[test]
        fn a_movie_header_round_trips(timescale in 1u32.., units in 1u32..u32::MAX, wide in proptest::bool::ANY) {
            let mvhd = if wide { mvhd_v1(timescale, u64::from(units)) } else { mvhd_v0(timescale, units) };
            let ms = u64::from(units) * 1000 / u64::from(timescale);
            proptest::prop_assert_eq!(length(boxed(*b"moov", &mvhd)), Some(ms).filter(|ms| *ms > 0));
        }

        /// A fragmented file's length is its fragments' summed durations.
        #[test]
        fn fragment_lengths_add_up(
            timescale in 1u32..100_000,
            fragments in proptest::collection::vec(proptest::collection::vec(1u32..10_000, 1..20), 1..8),
        ) {
            let total: u64 = fragments.iter().flatten().map(|d| u64::from(*d)).sum();
            let body: Vec<u8> = fragments.iter().flat_map(|durations| moof(1, None, durations)).collect();
            let file = [fragmented_moov(1, timescale, &[trex(1, 0)]), body].concat();
            proptest::prop_assert_eq!(length(file), millis(total, timescale));
        }
    }
}

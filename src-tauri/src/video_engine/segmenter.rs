//! Cuts the engine's MPEG-TS output into HLS segments in memory.
//!
//! The engine writes one continuous transport stream to a pipe (never to
//! disk: the bytes are decrypted video) with a keyframe forced on every
//! [`SEGMENT_SECS`] boundary. This cuts it at the first video keyframe on
//! or after each boundary, so segment `k` holds the video from `k * 4` s,
//! the position the playlist promises. Each segment starts with the latest
//! PAT and PMT so a player can open any segment on its own (after a seek).
//!
//! Transport stream framing, as much as is needed here: 188-byte packets
//! starting `0x47`; a 13-bit PID; `payload_unit_start` marks a packet where
//! a PES (or a PSI section) begins; the adaptation field's
//! `random_access_indicator` marks a keyframe; the PES header carries the
//! 33-bit, 90 kHz PTS.

use bytes::Bytes;

use super::plan::SEGMENT_SECS;

const PACKET: usize = 188;
const SYNC: u8 = 0x47;
const PAT_PID: u16 = 0;
/// A keyframe up to this early still opens the next segment (encoders round
/// a forced keyframe to the nearest frame): 50 ms at 90 kHz.
const EARLY_TOLERANCE: u64 = 4_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentError {
    /// A packet did not start with the sync byte.
    LostSync,
}

/// One segmenter per engine run.
#[derive(Debug)]
pub struct Segmenter {
    /// The index of the segment being filled.
    index: u32,
    /// The index this run started at.
    first: u32,
    /// The run's first video PTS: time zero of the run.
    base: Option<u64>,
    pmt_pid: Option<u16>,
    pat: Option<[u8; PACKET]>,
    pmt: Option<[u8; PACKET]>,
    current: Vec<u8>,
    /// Bytes of a packet split across two reads.
    partial: Vec<u8>,
}

impl Segmenter {
    #[must_use]
    pub fn new(first_index: u32) -> Self {
        Self {
            index: first_index,
            first: first_index,
            base: None,
            pmt_pid: None,
            pat: None,
            pmt: None,
            current: Vec::new(),
            partial: Vec::new(),
        }
    }

    /// Feed bytes as they arrive; returns every segment they completed.
    ///
    /// # Errors
    ///
    /// [`SegmentError::LostSync`] when the stream is not transport stream.
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Vec<(u32, Bytes)>, SegmentError> {
        let mut done = Vec::new();
        if !self.partial.is_empty() {
            let need = PACKET - self.partial.len();
            let take = need.min(bytes.len());
            self.partial.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.partial.len() < PACKET {
                return Ok(done);
            }
            let packet: [u8; PACKET] = self.partial[..].try_into().map_err(|_| SegmentError::LostSync)?;
            self.partial.clear();
            self.packet(&packet, &mut done)?;
        }
        let mut chunks = bytes.chunks_exact(PACKET);
        for chunk in &mut chunks {
            let packet: [u8; PACKET] = chunk.try_into().map_err(|_| SegmentError::LostSync)?;
            self.packet(&packet, &mut done)?;
        }
        self.partial.extend_from_slice(chunks.remainder());
        Ok(done)
    }

    /// The stream ended: the last segment, if it holds anything.
    #[must_use]
    pub fn finish(mut self) -> Option<(u32, Bytes)> {
        (self.current.len() > self.header_len()).then(|| (self.index, Bytes::from(std::mem::take(&mut self.current))))
    }

    fn header_len(&self) -> usize {
        PACKET * (usize::from(self.pat.is_some()) + usize::from(self.pmt.is_some()))
    }

    fn packet(&mut self, p: &[u8; PACKET], done: &mut Vec<(u32, Bytes)>) -> Result<(), SegmentError> {
        if p[0] != SYNC {
            return Err(SegmentError::LostSync);
        }
        let pid = (u16::from(p[1] & 0x1f) << 8) | u16::from(p[2]);
        let start = p[1] & 0x40 != 0;
        let adaptation = (p[3] >> 4) & 0x3;
        let mut payload = 4;
        let mut random_access = false;
        if adaptation & 0x2 != 0 {
            let len = usize::from(p[4]);
            random_access = len > 0 && p[5] & 0x40 != 0;
            payload = 5 + len;
        }
        let has_payload = adaptation & 0x1 != 0 && payload < PACKET;

        if pid == PAT_PID {
            if start && has_payload {
                self.pmt_pid = pmt_pid_from_pat(&p[payload..]).or(self.pmt_pid);
            }
            self.pat = Some(*p);
        } else if Some(pid) == self.pmt_pid {
            self.pmt = Some(*p);
        } else if start
            && has_payload
            && let Some((stream_id, pts)) = pes_start(&p[payload..])
            && (0xE0..=0xEF).contains(&stream_id)
        {
            // A video PES begins here.
            let base = *self.base.get_or_insert(pts);
            let next_boundary = base + u64::from(self.index - self.first + 1) * u64::from(SEGMENT_SECS) * 90_000;
            if random_access && pts + EARLY_TOLERANCE >= next_boundary && self.current.len() > self.header_len() {
                done.push((self.index, Bytes::from(std::mem::take(&mut self.current))));
                // A keyframe that arrives past several boundaries (an encoder
                // that ignored the forced ones) opens the segment it falls in.
                let elapsed = (pts + EARLY_TOLERANCE).saturating_sub(base) / (u64::from(SEGMENT_SECS) * 90_000);
                self.index = self.first + u32::try_from(elapsed).unwrap_or(u32::MAX - self.first);
            }
        }
        if self.current.is_empty() {
            // Every segment opens with the tables a player needs to read it.
            if pid != PAT_PID
                && let Some(pat) = self.pat
            {
                self.current.extend_from_slice(&pat);
            }
            if Some(pid) != self.pmt_pid
                && pid != PAT_PID
                && let Some(pmt) = self.pmt
            {
                self.current.extend_from_slice(&pmt);
            }
        }
        self.current.extend_from_slice(p);
        Ok(())
    }
}

/// The first program's PMT PID from a PAT section payload (pointer field
/// first).
fn pmt_pid_from_pat(payload: &[u8]) -> Option<u16> {
    let pointer = usize::from(*payload.first()?);
    let section = payload.get(1 + pointer..)?;
    if *section.first()? != 0x00 {
        return None;
    }
    let section_len = (usize::from(section.get(1)? & 0x0f) << 8) | usize::from(*section.get(2)?);
    // Programs start after the 8-byte header and stop before the CRC.
    let end = (3 + section_len).saturating_sub(4).min(section.len());
    let mut i = 8;
    while i + 4 <= end {
        let program = (u16::from(section[i]) << 8) | u16::from(section[i + 1]);
        let pid = (u16::from(section[i + 2] & 0x1f) << 8) | u16::from(section[i + 3]);
        if program != 0 {
            return Some(pid);
        }
        i += 4;
    }
    None
}

/// The stream id and PTS of a PES that starts at `payload`, if it has a PTS.
fn pes_start(payload: &[u8]) -> Option<(u8, u64)> {
    if payload.len() < 14 || payload[..3] != [0, 0, 1] {
        return None;
    }
    let stream_id = payload[3];
    if payload[7] & 0x80 == 0 {
        return None;
    }
    let b = &payload[9..14];
    let pts = (u64::from(b[0] >> 1) & 0x7) << 30 | u64::from(b[1]) << 22 | u64::from(b[2] >> 1) << 15 | u64::from(b[3]) << 7 | u64::from(b[4] >> 1);
    Some((stream_id, pts))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const PMT: u16 = 0x1000;
    const VIDEO: u16 = 0x100;
    const AUDIO: u16 = 0x101;

    fn header(pid: u16, start: bool, random_access: bool) -> Vec<u8> {
        let mut p = vec![SYNC, (if start { 0x40 } else { 0 }) | ((pid >> 8) as u8 & 0x1f), (pid & 0xff) as u8];
        if random_access {
            p.extend_from_slice(&[0x30, 1, 0x40]);
        } else {
            p.push(0x10);
        }
        p
    }

    fn finish(mut p: Vec<u8>) -> Vec<u8> {
        p.resize(PACKET, 0xff);
        p
    }

    pub(crate) fn pat() -> Vec<u8> {
        let mut p = header(PAT_PID, true, false);
        // pointer, table 0, length 13, ts id, version, sections, program 1 -> PMT, CRC
        p.extend_from_slice(&[
            0,
            0x00,
            0xb0,
            13,
            0,
            1,
            0xc1,
            0,
            0,
            0,
            1,
            0xe0 | (PMT >> 8) as u8,
            (PMT & 0xff) as u8,
            0,
            0,
            0,
            0,
        ]);
        finish(p)
    }

    fn pmt() -> Vec<u8> {
        let mut p = header(PMT, true, false);
        p.extend_from_slice(&[0, 0x02, 0xb0, 0x12]);
        finish(p)
    }

    fn pes(pid: u16, stream_id: u8, pts: u64, keyframe: bool) -> Vec<u8> {
        let mut p = header(pid, true, keyframe);
        let b = [
            0x21 | (((pts >> 30) & 7) << 1) as u8,
            (pts >> 22) as u8,
            ((((pts >> 15) & 0x7f) << 1) | 1) as u8,
            (pts >> 7) as u8,
            (((pts & 0x7f) << 1) | 1) as u8,
        ];
        p.extend_from_slice(&[0, 0, 1, stream_id, 0, 0, 0x80, 0x80, 5]);
        p.extend_from_slice(&b);
        finish(p)
    }

    fn continuation(pid: u16) -> Vec<u8> {
        finish(header(pid, false, false))
    }

    /// 0.5 s frames, keyframes every 2 s, from `pts0`, `seconds` long.
    fn stream(pts0: u64, seconds: u64) -> Vec<u8> {
        let mut out = pat();
        out.extend(pmt());
        for half in 0..seconds * 2 {
            let pts = pts0 + half * 45_000;
            out.extend(pes(AUDIO, 0xC0, pts, false));
            out.extend(pes(VIDEO, 0xE0, pts, half % 4 == 0));
            out.extend(continuation(VIDEO));
        }
        out
    }

    fn first_video_pts(segment: &[u8]) -> Option<u64> {
        segment.chunks(PACKET).find_map(|p| {
            let pid = (u16::from(p[1] & 0x1f) << 8) | u16::from(p[2]);
            if pid != VIDEO || p[1] & 0x40 == 0 {
                return None;
            }
            let off = if (p[3] >> 4) & 2 != 0 { 5 + usize::from(p[4]) } else { 4 };
            pes_start(&p[off..]).map(|(_, pts)| pts)
        })
    }

    #[test]
    fn segments_are_cut_on_the_keyframe_at_each_boundary() {
        let base = 126_000; // the 1.4 s every engine run starts at
        let mut seg = Segmenter::new(0);
        let mut out = seg.push(&stream(base, 10)).unwrap();
        out.extend(seg.finish());
        let indices: Vec<u32> = out.iter().map(|(i, _)| *i).collect();
        assert_eq!(indices, vec![0, 1, 2]);
        assert_eq!(first_video_pts(&out[1].1), Some(base + 4 * 90_000));
        assert_eq!(first_video_pts(&out[2].1), Some(base + 8 * 90_000));
        for (_, bytes) in &out {
            assert_eq!(bytes.len() % PACKET, 0);
            assert_eq!(&bytes[..PACKET], &pat()[..], "every segment opens with the PAT");
        }
    }

    /// A run started for a seek numbers its segments from there.
    #[test]
    fn a_run_from_a_seek_numbers_from_its_first_segment() {
        let mut seg = Segmenter::new(7);
        let mut out = seg.push(&stream(126_000 + 28 * 90_000, 6)).unwrap();
        out.extend(seg.finish());
        assert_eq!(out.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![7, 8]);
    }

    /// Reads from a pipe split packets anywhere; the result is the same.
    #[test]
    fn packets_split_across_reads_are_reassembled() {
        let bytes = stream(0, 9);
        let mut whole = Segmenter::new(0);
        let mut a = whole.push(&bytes).unwrap();
        a.extend(whole.finish());
        let mut split = Segmenter::new(0);
        let mut b = Vec::new();
        for chunk in bytes.chunks(1000) {
            b.extend(split.push(chunk).unwrap());
        }
        b.extend(split.finish());
        assert_eq!(a, b);
    }

    /// An encoder that ignores the forced keyframes: a keyframe at 9 s opens
    /// segment 2 (8-12 s), not segment 1.
    #[test]
    fn a_late_keyframe_opens_the_segment_it_falls_in() {
        let mut bytes = pat();
        bytes.extend(pmt());
        bytes.extend(pes(VIDEO, 0xE0, 0, true));
        bytes.extend(pes(VIDEO, 0xE0, 9 * 90_000, true));
        bytes.extend(pes(VIDEO, 0xE0, 10 * 90_000, false));
        let mut seg = Segmenter::new(0);
        let mut out = seg.push(&bytes).unwrap();
        out.extend(seg.finish());
        assert_eq!(out.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![0, 2]);
    }

    #[test]
    fn garbage_is_refused() {
        let mut seg = Segmenter::new(0);
        assert_eq!(seg.push(&[0u8; PACKET]), Err(SegmentError::LostSync));
    }

    #[test]
    fn the_pat_names_the_pmt() {
        let p = pat();
        assert_eq!(pmt_pid_from_pat(&p[4..]), Some(PMT));
        assert_eq!(pmt_pid_from_pat(&[]), None);
    }
}

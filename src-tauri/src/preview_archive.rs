//! Container check for the Office previews (DOCX, XLSX, PPTX).
//!
//! Every OOXML file is a zip archive, and the renderers in the webview unzip
//! it with JavaScript readers we do not control: pptx-viewer bundles fflate,
//! whose `unzipSync` loops forever on a malformed ZIP64 extra field
//! (CVE-2026-45820), and docx-preview and the spreadsheet readers inflate every
//! entry into memory. A 145-byte `.pptx` froze the whole window.
//!
//! So before a renderer is handed an Office file, this module reads the zip's
//! central directory (the sizes are recorded there, so nothing is inflated)
//! and refuses anything a renderer could choke on:
//!
//! - ZIP64 in any form. No Office file inside the preview caps needs it, and
//!   it is exactly where the fflate hang lives.
//! - A directory it cannot walk: truncated, multi-disk, an entry pointing past
//!   the directory, an extra field that overruns its entry.
//! - More than [`MAX_ARCHIVE_ENTRIES`] entries, more than
//!   [`MAX_ARCHIVE_UNCOMPRESSED_BYTES`] declared uncompressed, or a declared
//!   expansion above [`MAX_ARCHIVE_EXPANSION_RATIO`] (a zip bomb).
//!
//! The limits match the mobile app's guard, so a file previews on both or on
//! neither. This is a container check, not a document parser: entry names and
//! payloads are never read.

use std::io::{Read, Seek, SeekFrom};

use serde::Deserialize;

use crate::error::{AppError, Result};
use crate::media_preview::PREVIEW_TOO_LARGE;

/// Total uncompressed bytes an Office archive may declare.
pub const MAX_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 120 * 1024 * 1024;
/// Entries an Office archive may declare. A real deck is in the hundreds.
pub const MAX_ARCHIVE_ENTRIES: u64 = 5000;
/// Uncompressed / compressed. Office files sit around 2 to 8 times; 200 is a bomb.
pub const MAX_ARCHIVE_EXPANSION_RATIO: u64 = 200;

/// Copy for an archive the check could not read or would not trust. Owned
/// here, like [`PREVIEW_TOO_LARGE`], so the viewer never words it itself.
pub const PREVIEW_UNREADABLE_ARCHIVE: &str = "This file couldn't be read for a preview. Download it to open it.";

const LOCAL_HEADER_SIGNATURE: u32 = 0x0403_4b50;
const CENTRAL_HEADER_SIGNATURE: u32 = 0x0201_4b50;
const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const ZIP64_EXTRA_ID: u16 = 0x0001;
const EOCD_SIZE: u64 = 22;
const ZIP64_LOCATOR_SIZE: usize = 20;
const CENTRAL_HEADER_SIZE: usize = 46;
const LOCAL_HEADER_SIZE: u64 = 30;
/// The end record sits in the last 22 bytes plus at most a 64 KiB comment.
const EOCD_SEARCH_WINDOW: u64 = EOCD_SIZE + 0xFFFF;

/// The Office renderers, named as the frontend's `PreviewType` names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OfficePreviewFormat {
    Document,
    Spreadsheet,
    Presentation,
}

/// Why an archive was refused. Kept apart from the user copy so the tests can
/// tell the causes apart and the log can name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveRefusal {
    Unreadable,
    Zip64,
    TooManyEntries,
    TooLarge,
    ExpansionRatio,
}

impl ArchiveRefusal {
    fn user_message(self) -> &'static str {
        match self {
            Self::Unreadable | Self::Zip64 => PREVIEW_UNREADABLE_ARCHIVE,
            Self::TooManyEntries | Self::TooLarge | Self::ExpansionRatio => PREVIEW_TOO_LARGE,
        }
    }
}

/// What the central directory declares, for an archive that passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveSummary {
    pub entries: u64,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
}

/// Check a file the frontend is about to hand to an Office renderer.
///
/// A DOCX or PPTX must be a zip and pass [`inspect_archive`]. A spreadsheet
/// may also be a CSV, which never reaches a zip reader, so it is checked only
/// when its first bytes are what SheetJS takes for a zip (`PK` followed by two
/// bytes below 9; that covers the `PK\x03\x04` test the spreadsheet parser
/// uses too). A CSV whose header starts with the letters `PK` is not mistaken
/// for one.
pub fn check_office_preview<R: Read + Seek>(format: OfficePreviewFormat, reader: &mut R) -> Result<()> {
    if format == OfficePreviewFormat::Spreadsheet {
        let mut head = [0u8; 4];
        reader.seek(SeekFrom::Start(0))?;
        let read = read_up_to(reader, &mut head)?;
        let zip_like = read == 4 && head[0] == b'P' && head[1] == b'K' && head[2] < 9 && head[3] < 9;
        if !zip_like {
            return Ok(());
        }
    }
    inspect_archive(reader).map(|_| ()).map_err(|refusal| {
        tracing::info!(?refusal, ?format, "office preview refused by the archive check");
        AppError::Validation(refusal.user_message().into())
    })
}

/// Read the central directory and apply the limits. Seeks to the end record
/// and the directory, so only those bytes are read, never the entries.
pub fn inspect_archive<R: Read + Seek>(reader: &mut R) -> std::result::Result<ArchiveSummary, ArchiveRefusal> {
    inspect(reader).map_err(|error| match error {
        Inspect::Refused(refusal) => refusal,
        // A read that fails partway is an archive we cannot vouch for.
        Inspect::Io => ArchiveRefusal::Unreadable,
    })
}

enum Inspect {
    Refused(ArchiveRefusal),
    Io,
}

impl From<std::io::Error> for Inspect {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

impl From<ArchiveRefusal> for Inspect {
    fn from(refusal: ArchiveRefusal) -> Self {
        Self::Refused(refusal)
    }
}

fn inspect<R: Read + Seek>(reader: &mut R) -> std::result::Result<ArchiveSummary, Inspect> {
    use ArchiveRefusal::{ExpansionRatio, TooLarge, TooManyEntries, Unreadable, Zip64};

    let length = reader.seek(SeekFrom::End(0))?;
    if length < EOCD_SIZE + 4 {
        return Err(Unreadable.into());
    }
    // A real Office file starts with its first entry. fflate never looks here,
    // which is how a file that is only a directory reaches it.
    let mut head = [0u8; 4];
    reader.seek(SeekFrom::Start(0))?;
    reader.read_exact(&mut head)?;
    if u32::from_le_bytes(head) != LOCAL_HEADER_SIGNATURE {
        return Err(Unreadable.into());
    }

    let window_start = length.saturating_sub(EOCD_SEARCH_WINDOW);
    let mut window = vec![0u8; usize::try_from(length - window_start).map_err(|_| Unreadable)?];
    reader.seek(SeekFrom::Start(window_start))?;
    reader.read_exact(&mut window)?;

    // The LAST end record, scanning back from the end: the one fflate and
    // JSZip both settle on, so the directory checked is the one they parse.
    let eocd = (0..=window.len() - EOCD_SIZE as usize)
        .rev()
        .find(|&at| u32_at(&window, at) == Some(EOCD_SIGNATURE))
        .ok_or(Unreadable)?;
    let field16 = |offset: usize| u16_at(&window, eocd + offset).ok_or(Unreadable);
    let field32 = |offset: usize| u32_at(&window, eocd + offset).ok_or(Unreadable);
    let this_disk = field16(4)?;
    let directory_disk = field16(6)?;
    let entries_here = field16(8)?;
    let entries_total = field16(10)?;
    let directory_size = field32(12)?;
    let directory_offset = field32(16)?;

    let locator_present = eocd >= ZIP64_LOCATOR_SIZE && u32_at(&window, eocd - ZIP64_LOCATOR_SIZE) == Some(ZIP64_LOCATOR_SIGNATURE);
    if locator_present || entries_here == u16::MAX || entries_total == u16::MAX || directory_size == u32::MAX || directory_offset == u32::MAX {
        return Err(Zip64.into());
    }
    if this_disk != 0 || directory_disk != 0 || entries_here != entries_total {
        return Err(Unreadable.into());
    }
    if u64::from(entries_total) > MAX_ARCHIVE_ENTRIES {
        return Err(TooManyEntries.into());
    }

    let eocd_absolute = window_start + eocd as u64;
    let directory_offset = u64::from(directory_offset);
    let directory_size = u64::from(directory_size);
    if directory_offset.checked_add(directory_size).is_none_or(|end| end > eocd_absolute) {
        return Err(Unreadable.into());
    }
    // Bounded by the file length just checked, and the file by the preview cap.
    let mut directory = vec![0u8; usize::try_from(directory_size).map_err(|_| Unreadable)?];
    reader.seek(SeekFrom::Start(directory_offset))?;
    reader.read_exact(&mut directory)?;

    let mut summary = ArchiveSummary {
        entries: 0,
        compressed_bytes: 0,
        uncompressed_bytes: 0,
    };
    let mut cursor = 0usize;
    for _ in 0..entries_total {
        let entry = directory.get(cursor..cursor + CENTRAL_HEADER_SIZE).ok_or(Unreadable)?;
        if u32_at(entry, 0) != Some(CENTRAL_HEADER_SIGNATURE) {
            return Err(Unreadable.into());
        }
        let field16 = |offset: usize| u16_at(entry, offset).ok_or(Unreadable);
        let field32 = |offset: usize| u32_at(entry, offset).ok_or(Unreadable);
        let compressed = field32(20)?;
        let uncompressed = field32(24)?;
        let name_length = usize::from(field16(28)?);
        let extra_length = usize::from(field16(30)?);
        let comment_length = usize::from(field16(32)?);
        let start_disk = field16(34)?;
        let local_offset = field32(42)?;

        if compressed == u32::MAX || uncompressed == u32::MAX || local_offset == u32::MAX || start_disk == u16::MAX {
            return Err(Zip64.into());
        }
        if start_disk != 0 || u64::from(local_offset) + LOCAL_HEADER_SIZE > directory_offset {
            return Err(Unreadable.into());
        }

        let extra_start = cursor + CENTRAL_HEADER_SIZE + name_length;
        let extra = directory.get(extra_start..extra_start + extra_length).ok_or(Unreadable)?;
        check_extra_fields(extra)?;

        summary.entries += 1;
        summary.compressed_bytes += u64::from(compressed);
        summary.uncompressed_bytes += u64::from(uncompressed);
        cursor = extra_start + extra_length + comment_length;
        if cursor > directory.len() {
            return Err(Unreadable.into());
        }
    }

    if summary.uncompressed_bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
        return Err(TooLarge.into());
    }
    // Deflate turns any non-empty input into at least a couple of bytes, so a
    // declared size with nothing compressed behind it is a lie, refused as a
    // bomb rather than divided by zero.
    if summary.uncompressed_bytes > summary.compressed_bytes.saturating_mul(MAX_ARCHIVE_EXPANSION_RATIO) {
        return Err(ExpansionRatio.into());
    }
    Ok(summary)
}

/// Walk an entry's extra fields. A ZIP64 field is refused outright (it is what
/// sends fflate into its endless loop), and so is a field whose declared
/// length runs past the extra block. Fewer than four trailing bytes are
/// padding some writers leave, not a field.
fn check_extra_fields(extra: &[u8]) -> std::result::Result<(), ArchiveRefusal> {
    let mut at = 0usize;
    while at + 4 <= extra.len() {
        let id = u16_at(extra, at).ok_or(ArchiveRefusal::Unreadable)?;
        let size = usize::from(u16_at(extra, at + 2).ok_or(ArchiveRefusal::Unreadable)?);
        if id == ZIP64_EXTRA_ID {
            return Err(ArchiveRefusal::Zip64);
        }
        at += 4 + size;
        if at > extra.len() {
            return Err(ArchiveRefusal::Unreadable);
        }
    }
    Ok(())
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// `read_exact` for a buffer the source may not fill (a file shorter than it).
fn read_up_to<R: Read>(reader: &mut R, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            read => filled += read,
        }
    }
    Ok(filled)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::time::{Duration, Instant};

    use zip::CompressionMethod;
    use zip::write::{SimpleFileOptions, ZipWriter};

    /// The 145-byte `.pptx` that hangs fflate's `unzipSync` (CVE-2026-45820):
    /// one central entry with a 0xFFFFFFFF compressed size, a ZIP64 end record
    /// and locator, and an end record whose every field says "see ZIP64".
    pub(crate) fn fflate_hang_poc() -> Vec<u8> {
        let mut b = vec![0u8; 145];
        let put16 = |b: &mut [u8], at: usize, v: u16| b[at..at + 2].copy_from_slice(&v.to_le_bytes());
        let put32 = |b: &mut [u8], at: usize, v: u32| b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        let put64 = |b: &mut [u8], at: usize, v: u64| b[at..at + 8].copy_from_slice(&v.to_le_bytes());
        put32(&mut b, 0, CENTRAL_HEADER_SIGNATURE);
        put16(&mut b, 4, 45);
        put16(&mut b, 6, 45);
        put32(&mut b, 20, u32::MAX);
        put16(&mut b, 28, 1);
        b[46] = b'a';
        let o = 47;
        put32(&mut b, o, 0x0606_4b50);
        put64(&mut b, o + 4, 44);
        put16(&mut b, o + 12, 45);
        put16(&mut b, o + 14, 45);
        put64(&mut b, o + 24, 1);
        put64(&mut b, o + 32, 1);
        put64(&mut b, o + 40, 47);
        let o = 103;
        put32(&mut b, o, ZIP64_LOCATOR_SIGNATURE);
        put64(&mut b, o + 8, 47);
        put32(&mut b, o + 16, 1);
        let o = 123;
        put32(&mut b, o, EOCD_SIGNATURE);
        put16(&mut b, o + 8, 0xFFFF);
        put16(&mut b, o + 10, 0xFFFF);
        put32(&mut b, o + 12, u32::MAX);
        put32(&mut b, o + 16, u32::MAX);
        b
    }

    /// A zip with the given entries, written by the `zip` crate the way a
    /// real Office writer lays one out.
    fn archive(entries: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(method);
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    const CONTENT_TYPES: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#;
    const RELS: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#;

    pub(crate) fn office_file(main_part: &str, body: &[u8]) -> Vec<u8> {
        archive(
            &[("[Content_Types].xml", CONTENT_TYPES), ("_rels/.rels", RELS), (main_part, body)],
            CompressionMethod::Deflated,
        )
    }

    fn check(format: OfficePreviewFormat, bytes: &[u8]) -> Result<()> {
        check_office_preview(format, &mut Cursor::new(bytes))
    }

    fn refusal(bytes: &[u8]) -> ArchiveRefusal {
        inspect_archive(&mut Cursor::new(bytes)).expect_err("archive should be refused")
    }

    #[test]
    fn the_fflate_hang_poc_is_refused_quickly() {
        let poc = fflate_hang_poc();
        assert_eq!(poc.len(), 145);
        let started = Instant::now();
        for format in [
            OfficePreviewFormat::Presentation,
            OfficePreviewFormat::Document,
            OfficePreviewFormat::Spreadsheet,
        ] {
            let error = check(format, &poc).expect_err("the PoC must never reach a renderer");
            assert!(
                matches!(error, AppError::Validation(ref m) if m == PREVIEW_UNREADABLE_ARCHIVE),
                "{error:?}"
            );
        }
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "refusing the PoC took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_poc_directory_behind_a_real_first_entry_is_refused_as_zip64() {
        // The PoC as-is is caught by its missing local header. Put a real
        // entry in front of it and the ZIP64 markers alone must still refuse.
        let mut bytes = archive(&[("a", b"x")], CompressionMethod::Stored);
        let cut = bytes.windows(4).position(|w| w == CENTRAL_HEADER_SIGNATURE.to_le_bytes()).unwrap();
        bytes.truncate(cut);
        bytes.extend_from_slice(&fflate_hang_poc());
        assert_eq!(refusal(&bytes), ArchiveRefusal::Zip64);
    }

    #[test]
    fn real_office_archives_pass() {
        let docx = office_file("word/document.xml", b"<w:document><w:body><w:p/></w:body></w:document>");
        let xlsx = office_file("xl/workbook.xml", b"<workbook><sheets><sheet name=\"Data\"/></sheets></workbook>");
        let pptx = office_file("ppt/presentation.xml", b"<p:presentation><p:sldIdLst/></p:presentation>");
        check(OfficePreviewFormat::Document, &docx).unwrap();
        check(OfficePreviewFormat::Spreadsheet, &xlsx).unwrap();
        check(OfficePreviewFormat::Presentation, &pptx).unwrap();
        let summary = inspect_archive(&mut Cursor::new(&pptx)).unwrap();
        assert_eq!(summary.entries, 3);
    }

    #[test]
    fn a_csv_spreadsheet_is_not_an_archive() {
        check(OfficePreviewFormat::Spreadsheet, b"name,qty\nwidget,12\n").unwrap();
        // A header that happens to start with the letters PK is still a CSV.
        check(OfficePreviewFormat::Spreadsheet, b"PK,Name\n1,Widget\n").unwrap();
        check(OfficePreviewFormat::Spreadsheet, b"").unwrap();
    }

    #[test]
    fn a_document_or_deck_that_is_not_a_zip_is_refused() {
        for format in [OfficePreviewFormat::Document, OfficePreviewFormat::Presentation] {
            let error = check(format, b"this is not a word document at all, just text").unwrap_err();
            assert!(matches!(error, AppError::Validation(ref m) if m == PREVIEW_UNREADABLE_ARCHIVE));
        }
        assert_eq!(refusal(b"PK\x03\x04"), ArchiveRefusal::Unreadable);
    }

    #[test]
    fn a_zip64_extra_field_is_refused() {
        let mut bytes = archive(&[("a", b"hello")], CompressionMethod::Stored);
        // Rewrite the central entry's extra field as a ZIP64 one: grow the
        // record by an 8-byte extra and fix up the end record.
        let central = bytes.windows(4).position(|w| w == CENTRAL_HEADER_SIGNATURE.to_le_bytes()).unwrap();
        let name_length = usize::from(u16_at(&bytes, central + 28).unwrap());
        let existing_extra = usize::from(u16_at(&bytes, central + 30).unwrap());
        assert_eq!(existing_extra, 0, "fixture assumes no extra field yet");
        let insert_at = central + CENTRAL_HEADER_SIZE + name_length;
        bytes.splice(insert_at..insert_at, [0x01, 0x00, 0x04, 0x00, 0, 0, 0, 0]);
        bytes[central + 30..central + 32].copy_from_slice(&8u16.to_le_bytes());
        let eocd = bytes.len() - EOCD_SIZE as usize;
        let size = u32_at(&bytes, eocd + 12).unwrap() + 8;
        bytes[eocd + 12..eocd + 16].copy_from_slice(&size.to_le_bytes());
        assert_eq!(refusal(&bytes), ArchiveRefusal::Zip64);

        // The same field with a length running past the block is unreadable.
        bytes[insert_at + 2..insert_at + 4].copy_from_slice(&0x40u16.to_le_bytes());
        bytes[insert_at..insert_at + 2].copy_from_slice(&0x5455u16.to_le_bytes());
        assert_eq!(refusal(&bytes), ArchiveRefusal::Unreadable);
    }

    #[test]
    fn a_truncated_or_damaged_directory_is_refused() {
        let bytes = office_file("word/document.xml", b"<w:document/>");
        // Cut off before the end record.
        assert_eq!(refusal(&bytes[..bytes.len() - 30]), ArchiveRefusal::Unreadable);
        // A directory offset pointing past the end record.
        let mut moved = bytes.clone();
        let eocd = moved.len() - EOCD_SIZE as usize;
        moved[eocd + 16..eocd + 20].copy_from_slice(&(eocd as u32).to_le_bytes());
        assert_eq!(refusal(&moved), ArchiveRefusal::Unreadable);
        // More entries declared than the directory holds.
        let mut overcounted = bytes.clone();
        overcounted[eocd + 8..eocd + 10].copy_from_slice(&4u16.to_le_bytes());
        overcounted[eocd + 10..eocd + 12].copy_from_slice(&4u16.to_le_bytes());
        assert_eq!(refusal(&overcounted), ArchiveRefusal::Unreadable);
    }

    #[test]
    fn a_zip_bomb_is_refused_by_its_expansion_ratio() {
        // 2 MiB of zeros deflates to a few KiB: far past 200 to 1, while the
        // total stays under the size cap, so the ratio is what refuses it.
        let zeros = vec![0u8; 2 * 1024 * 1024];
        let bomb = archive(&[("ppt/slides/slide1.xml", &zeros)], CompressionMethod::Deflated);
        assert_eq!(refusal(&bomb), ArchiveRefusal::ExpansionRatio);
        let error = check(OfficePreviewFormat::Presentation, &bomb).unwrap_err();
        assert!(matches!(error, AppError::Validation(ref m) if m == PREVIEW_TOO_LARGE));

        // Ordinary text compresses well but nowhere near that.
        let text: Vec<u8> = (0..200_000u32).flat_map(|i| format!("<w:t>row {i}</w:t>").into_bytes()).collect();
        inspect_archive(&mut Cursor::new(archive(&[("word/document.xml", &text)], CompressionMethod::Deflated))).unwrap();
    }

    #[test]
    fn the_declared_total_is_capped() {
        // Stored entries have a 1:1 ratio, so only the size cap can stop
        // them. Declare the sizes instead of writing 120 MiB.
        let mut bytes = archive(&[("a", b"x"), ("b", b"y")], CompressionMethod::Stored);
        let mut at = 0;
        let half = u32::try_from(MAX_ARCHIVE_UNCOMPRESSED_BYTES / 2 + 1).unwrap();
        while let Some(found) = bytes[at..].windows(4).position(|w| w == CENTRAL_HEADER_SIGNATURE.to_le_bytes()) {
            let central = at + found;
            bytes[central + 20..central + 24].copy_from_slice(&half.to_le_bytes());
            bytes[central + 24..central + 28].copy_from_slice(&half.to_le_bytes());
            at = central + 4;
        }
        assert_eq!(refusal(&bytes), ArchiveRefusal::TooLarge);
    }

    #[test]
    fn the_entry_count_is_capped() {
        let names: Vec<String> = (0..=MAX_ARCHIVE_ENTRIES).map(|i| format!("ppt/media/{i}")).collect();
        let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
        let too_many = archive(&entries, CompressionMethod::Stored);
        assert_eq!(refusal(&too_many), ArchiveRefusal::TooManyEntries);
        let error = check(OfficePreviewFormat::Presentation, &too_many).unwrap_err();
        assert!(matches!(error, AppError::Validation(ref m) if m == PREVIEW_TOO_LARGE));

        let at_limit = archive(&entries[..MAX_ARCHIVE_ENTRIES as usize], CompressionMethod::Stored);
        assert_eq!(inspect_archive(&mut Cursor::new(at_limit)).unwrap().entries, MAX_ARCHIVE_ENTRIES);
    }

    #[test]
    fn a_zip64_end_record_is_refused_even_with_ordinary_entries() {
        let mut bytes = office_file("xl/workbook.xml", b"<workbook/>");
        let eocd = bytes.len() - EOCD_SIZE as usize;
        bytes[eocd + 16..eocd + 20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(refusal(&bytes), ArchiveRefusal::Zip64);
    }
}

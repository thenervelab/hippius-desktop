//! A file link's Insights as a CSV file, the console's "Export CSV".
//!
//! One row per viewer, in the console's columns (`insights-csv.ts`
//! `fileLinkCsv`): File, Viewer, Email (only when some viewer proved one on a
//! link that asks for it), Viewer ID, Visits, Last viewed, Watched (%), Pages
//! seen, Pages. The file is named like the console's: "Q3 report activity
//! 2026-11-10.csv".
//!
//! The rows are read fresh through [`share_get_insights`], so names and
//! emails are the ones Rust opened with the link's key, never text the
//! webview hands back. The save dialog is the frontend's (a UI concern, as
//! for chat attachments and downloads); this side owns the file: an absolute
//! destination and a temp-file-plus-rename, so a crash mid-write never leaves
//! half a file.
//!
//! Names and file names come from other people, so a cell a spreadsheet
//! would read as a formula is written as text (see [`csv_cell`]).

use std::path::Path;

use tracing::info;

use super::insights::{Gated, InsightsViewer, ShareInsights, share_get_insights};
use crate::app_state::AppState;
use crate::chat::attachments::validate_destination;
use crate::error::{AppError, Result};

/// The row a viewer with no name gets, the console's words.
pub const ANONYMOUS_VIEWER: &str = "Anonymous viewer";

/// Said when there is nothing to export: the plan locks the viewer list.
pub const NOTHING_TO_EXPORT: &str = "There's no viewer activity to export on this plan.";

/// One cell: quoted when it must be, and never a live formula.
///
/// A text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return
/// is read as a formula by common spreadsheet apps, so it gets a leading `'`
/// (the console's rule, byte for byte). Numbers are ours and stay numbers.
pub fn csv_cell(value: &Cell) -> String {
    let s = match value {
        Cell::Empty => return String::new(),
        Cell::Number(n) => return n.to_string(),
        Cell::Text(t) if t.starts_with(['=', '+', '-', '@', '\t', '\r']) => format!("'{t}"),
        Cell::Text(t) => t.clone(),
    };
    if s.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// A CSV cell before it is written.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Number(u64),
    Text(String),
}

impl Cell {
    fn text(s: impl Into<String>) -> Self {
        Cell::Text(s.into())
    }
    fn opt_num(n: Option<impl Into<u64>>) -> Self {
        n.map_or(Cell::Empty, |n| Cell::Number(n.into()))
    }
}

/// Rows joined with CRLF, ending in one, as the console writes them.
pub fn to_csv(rows: &[Vec<Cell>]) -> String {
    let mut out = String::new();
    for row in rows {
        out.push_str(&row.iter().map(csv_cell).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

/// 0 to 1 as a whole percentage, clamped; nothing for no value.
fn percent(fraction: Option<f64>) -> Cell {
    match fraction {
        Some(f) if f.is_finite() => Cell::Number((f.clamp(0.0, 1.0) * 100.0).round() as u64),
        _ => Cell::Empty,
    }
}

/// A file link's viewers as CSV. Refused when the plan locks the viewer list:
/// a locked list carries no rows, and an empty file would read as "nobody".
pub fn file_link_csv(file_name: &str, insights: &ShareInsights) -> Result<String> {
    let viewers: &[InsightsViewer] = match &insights.viewers {
        Gated::Shown(v) => v,
        Gated::Locked => return Err(AppError::Validation(NOTHING_TO_EXPORT.into())),
    };
    let with_email = viewers.iter().any(|v| v.email.is_some());
    let mut header = vec![Cell::text("File"), Cell::text("Viewer")];
    if with_email {
        header.push(Cell::text("Email"));
    }
    for h in ["Viewer ID", "Visits", "Last viewed", "Watched (%)", "Pages seen", "Pages"] {
        header.push(Cell::text(h));
    }
    let mut rows = vec![header];
    for v in viewers {
        let mut row = vec![
            Cell::text(file_name),
            Cell::text(v.name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(ANONYMOUS_VIEWER)),
        ];
        if with_email {
            row.push(v.email.clone().map_or(Cell::Empty, Cell::Text));
        }
        row.extend([
            Cell::text(&v.viewer_id),
            Cell::Number(v.visits),
            v.last_viewed_at.clone().map_or(Cell::Empty, Cell::Text),
            percent(v.completion),
            Cell::opt_num(v.pages_seen),
            Cell::opt_num(v.page_count),
        ]);
        rows.push(row);
    }
    Ok(to_csv(&rows))
}

/// "Q3 report.pdf" on 2026-11-10 to "Q3 report activity 2026-11-10.csv":
/// the extension off, characters no file system takes turned to spaces, at
/// most 80 characters of name. The console's `csvFilename`.
pub fn csv_file_name(name: &str, day: &str) -> String {
    let stem = match name.rfind('.') {
        Some(i) if (1..=8).contains(&(name.len() - i - 1)) && name[i + 1..].chars().all(|c| c.is_ascii_alphanumeric()) => &name[..i],
        _ => name,
    };
    let mut cleaned = String::with_capacity(stem.len());
    let mut in_bad = false;
    for c in stem.chars() {
        let bad = matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20;
        if bad {
            if !in_bad {
                cleaned.push(' ');
            }
            in_bad = true;
        } else {
            cleaned.push(c);
            in_bad = false;
        }
    }
    let base = cleaned.trim();
    let base = if base.is_empty() { "Insights" } else { base };
    let base: String = base.chars().take(80).collect();
    format!("{base} activity {day}.csv")
}

/// Writes `csv` to `destination` through a sibling temp file and a rename,
/// with a byte-order mark so spreadsheet apps read it as UTF-8. Replaces a
/// file already there: the save dialog asked about that.
pub fn write_csv(destination: &Path, csv: &str) -> Result<()> {
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::Validation("Destination has no parent directory".into()))?;
    if !parent.is_dir() {
        return Err(AppError::Validation(format!("Folder does not exist: {}", parent.display())));
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".hippius-insights-")
        .suffix(".part")
        .tempfile_in(parent)?;
    std::io::Write::write_all(&mut temp, "\u{FEFF}".as_bytes())?;
    std::io::Write::write_all(&mut temp, csv.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(destination).map_err(|e| AppError::Io(e.error))?;
    Ok(())
}

/// The name the save dialog suggests for a link's CSV, dated today.
#[tauri::command]
pub async fn share_insights_csv_name(file_name: String) -> Result<String> {
    Ok(csv_file_name(&file_name, &chrono::Local::now().format("%Y-%m-%d").to_string()))
}

/// Saves a file link's viewer activity as CSV at `destination`, the path
/// the save dialog returned.
#[tauri::command]
pub async fn share_export_insights_csv(state: tauri::State<'_, AppState>, share_token: String, file_name: String, destination: String) -> Result<()> {
    let destination = validate_destination(&destination)?;
    let insights = share_get_insights(state, share_token).await?;
    let csv = file_link_csv(&file_name, &insights)?;
    let path = destination.clone();
    tauri::async_runtime::spawn_blocking(move || write_csv(&path, &csv))
        .await
        .map_err(|e| AppError::Other(format!("save task failed: {e}")))??;
    info!(path = %destination.display(), "insights csv saved");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shares::insights::InsightsPlan;

    fn viewer(id: &str, name: Option<&str>, email: Option<&str>) -> InsightsViewer {
        InsightsViewer {
            viewer_id: id.into(),
            name: name.map(Into::into),
            visits: 2,
            watched_ms: 0,
            completion: Some(0.756),
            last_viewed_at: Some("2026-11-01T00:00:00Z".into()),
            comments: 0,
            reactions: 0,
            pages_seen: Some(3),
            page_count: Some(4),
            email: email.map(Into::into),
        }
    }

    fn insights(viewers: Gated<Vec<InsightsViewer>>) -> ShareInsights {
        ShareInsights {
            plan: InsightsPlan::Paid,
            total_views: 3,
            unique_viewers: 2,
            completion: Gated::Shown(None),
            retention: Gated::Shown(None),
            viewers,
            pages: None,
        }
    }

    #[test]
    fn quotes_what_must_be_quoted() {
        assert_eq!(csv_cell(&Cell::text("say \"hi\", then\nleave")), "\"say \"\"hi\"\", then\nleave\"");
        assert_eq!(csv_cell(&Cell::text("plain")), "plain");
        assert_eq!(csv_cell(&Cell::Empty), "");
        assert_eq!(csv_cell(&Cell::Number(42)), "42");
    }

    #[test]
    fn never_writes_a_live_formula_from_someone_elses_text() {
        assert_eq!(csv_cell(&Cell::text("=HYPERLINK(\"http://x\")")), "\"'=HYPERLINK(\"\"http://x\"\")\"");
        assert_eq!(csv_cell(&Cell::text("+1")), "'+1");
        assert_eq!(csv_cell(&Cell::text("-1")), "'-1");
        assert_eq!(csv_cell(&Cell::text("@SUM(A1)")), "'@SUM(A1)");
        assert_eq!(csv_cell(&Cell::text("\tcmd")), "'\tcmd");
        assert_eq!(csv_cell(&Cell::text("\rx")), "\"'\rx\"");
    }

    #[test]
    fn joins_rows_with_crlf() {
        assert_eq!(
            to_csv(&[vec![Cell::text("a"), Cell::Number(1)], vec![Cell::text("b"), Cell::Empty]]),
            "a,1\r\nb,\r\n"
        );
    }

    #[test]
    fn writes_one_row_per_viewer_in_the_consoles_columns() {
        let csv = file_link_csv(
            "Deck.pdf",
            &insights(Gated::Shown(vec![
                viewer("v1", Some("Ada"), Some("ada@example.com")),
                viewer("-v2", None, None),
            ])),
        )
        .unwrap();
        assert_eq!(
            csv.split("\r\n").collect::<Vec<_>>(),
            [
                "File,Viewer,Email,Viewer ID,Visits,Last viewed,Watched (%),Pages seen,Pages",
                "Deck.pdf,Ada,ada@example.com,v1,2,2026-11-01T00:00:00Z,76,3,4",
                "Deck.pdf,Anonymous viewer,,'-v2,2,2026-11-01T00:00:00Z,76,3,4",
                "",
            ]
        );
    }

    #[test]
    fn has_no_email_column_when_no_viewer_proved_one() {
        let csv = file_link_csv("a.mp4", &insights(Gated::Shown(vec![viewer("v1", Some("=cmd"), None)]))).unwrap();
        let lines: Vec<_> = csv.split("\r\n").collect();
        assert_eq!(lines[0], "File,Viewer,Viewer ID,Visits,Last viewed,Watched (%),Pages seen,Pages");
        assert_eq!(lines[1], "a.mp4,'=cmd,v1,2,2026-11-01T00:00:00Z,76,3,4");
    }

    #[test]
    fn refuses_a_locked_viewer_list() {
        let err = file_link_csv("a.mp4", &insights(Gated::Locked)).unwrap_err();
        assert!(matches!(err, AppError::Validation(m) if m == NOTHING_TO_EXPORT));
    }

    #[test]
    fn names_the_file_like_the_console() {
        assert_eq!(csv_file_name("Q3 report.pdf", "2026-11-10"), "Q3 report activity 2026-11-10.csv");
        assert_eq!(csv_file_name("a/b:c?.docx", "2026-11-10"), "a b c activity 2026-11-10.csv");
        assert_eq!(csv_file_name(".pdf", "2026-11-10"), "Insights activity 2026-11-10.csv");
        assert_eq!(csv_file_name("notes", "2026-11-10"), "notes activity 2026-11-10.csv");
        let long = "x".repeat(200) + ".pdf";
        assert_eq!(csv_file_name(&long, "d"), format!("{} activity d.csv", "x".repeat(80)));
    }

    #[test]
    fn writes_the_whole_file_with_a_bom_and_replaces_one_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.csv");
        std::fs::write(&dest, b"old").unwrap();
        write_csv(&dest, "a,b\r\n").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), "\u{FEFF}a,b\r\n".as_bytes());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name() != "out.csv")
            .collect();
        assert!(leftovers.is_empty());
        assert!(write_csv(&dir.path().join("missing").join("x.csv"), "a").is_err());
    }
}

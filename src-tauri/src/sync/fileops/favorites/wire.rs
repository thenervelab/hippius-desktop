//! Wire types of hcfs-server's favorites routes, and the key one star is
//! known by.
//!
//! The pinned hcfs-shared has the `PUT` body but not the `GET` listing, and
//! its item type cannot name a whole drive (`{"path": ""}`), so the desktop
//! reads and writes these with its own types. Shapes follow the server docs
//! (`favorites.md`): `PUT /favorites/{owner}/{folder_hash}` and
//! `GET /favorites/{own_ss58}`.

use serde::{Deserialize, Deserializer, Serialize};

/// Page size for `GET /favorites`, the server's cap.
pub const LIST_PAGE: u32 = 200;
/// Pages read at most: 6 × 200 covers the 1,000-star cap with room.
pub const MAX_PAGES: u32 = 6;

/// What one star names inside a drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StarItem {
    /// A file, by its 64-lowercase-hex `path_hash`.
    File(String),
    /// A folder by its path from the drive root; the empty path is the
    /// drive itself.
    Path(String),
}

/// `PUT` body: `{"item": {"file_id": …} | {"path": …}, "favorite": bool}`.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct SetFavoriteBody {
    pub item: ItemBody,
    pub favorite: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum ItemBody {
    File { file_id: String },
    Path { path: String },
}

impl SetFavoriteBody {
    pub fn new(item: &StarItem, favorite: bool) -> Self {
        let item = match item {
            StarItem::File(id) => ItemBody::File { file_id: id.clone() },
            StarItem::Path(path) => ItemBody::Path { path: path.clone() },
        };
        Self { item, favorite }
    }
}

/// `PUT` answer: the item's state after the call.
#[derive(Deserialize, Debug)]
pub struct SetFavoriteResult {
    pub favorite: bool,
}

/// One page of `GET /favorites/{ss58}`: drives, then folders, then files,
/// paged as one sequence.
#[derive(Deserialize, Debug, Default)]
pub struct FavoritesPage {
    #[serde(default)]
    pub drives: Vec<FavoriteDrive>,
    #[serde(default)]
    pub folders: Vec<FavoriteFolder>,
    #[serde(default)]
    pub files: Vec<FavoriteFile>,
    #[serde(default)]
    pub has_more: bool,
}

impl FavoritesPage {
    pub fn len(&self) -> usize {
        self.drives.len() + self.folders.len() + self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A starred drive: its `/list_folders` entry plus `owner_ss58`.
#[derive(Deserialize, Debug, Clone)]
pub struct FavoriteDrive {
    pub owner_ss58: String,
    pub folder_hash: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub created_at: Option<i64>,
}

/// A starred folder: a `/browse` folder plus its drive and path.
#[derive(Deserialize, Debug, Clone)]
pub struct FavoriteFolder {
    pub owner_ss58: String,
    pub folder_hash: String,
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub created_at: Option<i64>,
}

/// A starred file: a `/browse` file plus its drive and `file_id`.
#[derive(Deserialize, Debug, Clone)]
pub struct FavoriteFile {
    pub owner_ss58: String,
    pub folder_hash: String,
    #[serde(default)]
    pub file_id: Option<String>,
    /// Fallback for `file_id`: a JSON array of 32 numbers.
    #[serde(default, deserialize_with = "optional_path_hash")]
    pub path_hash: Option<Vec<u8>>,
    #[serde(default)]
    pub file_name: Option<String>,
    /// `null` for a file uploaded without a path: it has no folder to open.
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub uploaded_by: Option<String>,
    #[serde(default)]
    pub uploaded_by_name: Option<String>,
    /// The file's content hash, as `/browse` gives it: File Details shows it
    /// as the Arion hash, the same field a Drive row shows.
    #[serde(default)]
    pub arion_hash: Option<String>,
}

impl FavoriteFile {
    /// The file's id: `file_id`, else the hex of `path_hash`. `None` when
    /// neither is a 32-byte id, which leaves the row out rather than naming
    /// some other file.
    pub fn id(&self) -> Option<String> {
        if let Some(id) = self.file_id.as_deref().and_then(normalize_file_id) {
            return Some(id);
        }
        self.path_hash.as_ref().filter(|h| h.len() == 32).map(hex::encode)
    }
}

fn optional_path_hash<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<u8>>, D::Error> {
    // Anything but an array of bytes reads as absent: a fallback field must
    // not fail the whole page.
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|v| serde_json::from_value::<Vec<u8>>(v).ok()))
}

/// A file id as the server takes it: 64 hex characters, lowercased.
pub fn normalize_file_id(id: &str) -> Option<String> {
    let id = id.trim();
    (id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())).then(|| id.to_ascii_lowercase())
}

/// A drive's folder hash: 16 hex characters.
pub fn is_folder_hash(hash: &str) -> bool {
    hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A folder path as the server stores it: segments joined by `/`, with no
/// leading, trailing or doubled slash. `None` for a path that climbs out
/// (`..`), names `.` or uses a backslash.
pub fn normalize_path(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" => {}
            "." | ".." => return None,
            p if p.contains('\\') => return None,
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

/// The key one star is known by, the same string the webview builds with
/// `starKey` (`app/lib/tauri/starred.ts`); both sides pin it. The owner is
/// part of every key: drive hashes come from labels, so two owners' drives
/// can share a hash.
pub fn star_key(owner: &str, folder_hash: &str, item: &StarItem) -> String {
    match item {
        StarItem::File(id) => format!("{owner}|{folder_hash}|f:{id}"),
        StarItem::Path(path) if path.is_empty() => format!("{owner}|{folder_hash}|drive"),
        StarItem::Path(path) => format!("{owner}|{folder_hash}|d:{path}"),
    }
}

/// Why a favorites call did not succeed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FavoriteRefusal {
    /// The HTTP status; 0 when no answer arrived.
    pub status: u16,
    /// The server's error code, when the body named one.
    pub code: Option<String>,
}

impl FavoriteRefusal {
    pub fn no_answer() -> Self {
        Self::default()
    }

    pub fn is_retryable(&self) -> bool {
        self.status == 0 || self.status == 429 || self.status >= 500
    }

    /// The account already holds 1,000 stars.
    pub fn is_full(&self) -> bool {
        self.code.as_deref() == Some("favorites_full")
    }

    /// Read the code from `{"Error":{"error"|"code"}}` or a flat `{error}`.
    pub fn from_body(status: u16, body: &str) -> Self {
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
        let code_of = |v: &serde_json::Value| {
            v.get("error")
                .and_then(serde_json::Value::as_str)
                .or_else(|| v.get("code").and_then(serde_json::Value::as_str))
                .map(str::to_string)
        };
        let code = value.get("Error").and_then(code_of).or_else(|| code_of(&value));
        Self { status, code }
    }
}

/// The sentence a failed star or unstar shows. Names use straight quotes,
/// as the app's other toasts do.
pub fn failure_sentence(refusal: Option<&FavoriteRefusal>, name: &str, favorite: bool) -> String {
    if favorite && refusal.is_some_and(FavoriteRefusal::is_full) {
        return FULL_SENTENCE.to_string();
    }
    if favorite {
        format!("Couldn't star \"{name}\". Try again.")
    } else {
        format!("Couldn't unstar \"{name}\". Try again.")
    }
}

/// What starring past the cap says.
pub const FULL_SENTENCE: &str = "You can star up to 1,000 items. Unstar some to add more.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_bodies_name_a_file_a_folder_or_the_whole_drive() {
        let id = "ab".repeat(32);
        assert_eq!(
            serde_json::to_value(SetFavoriteBody::new(&StarItem::File(id.clone()), true)).unwrap(),
            serde_json::json!({ "item": { "file_id": id }, "favorite": true })
        );
        assert_eq!(
            serde_json::to_value(SetFavoriteBody::new(&StarItem::Path("A/B".into()), false)).unwrap(),
            serde_json::json!({ "item": { "path": "A/B" }, "favorite": false })
        );
        assert_eq!(
            serde_json::to_value(SetFavoriteBody::new(&StarItem::Path(String::new()), true)).unwrap(),
            serde_json::json!({ "item": { "path": "" }, "favorite": true })
        );
    }

    /// The same fixtures `app/lib/starred/__tests__` pins `starKey` with.
    #[test]
    fn keys_match_the_webview_format() {
        let (owner, hash) = ("5Own", "0123456789abcdef");
        let id = "ab".repeat(32);
        assert_eq!(
            star_key(owner, hash, &StarItem::File(id.clone())),
            format!("5Own|0123456789abcdef|f:{id}")
        );
        assert_eq!(star_key(owner, hash, &StarItem::Path("A/B".into())), "5Own|0123456789abcdef|d:A/B");
        assert_eq!(star_key(owner, hash, &StarItem::Path(String::new())), "5Own|0123456789abcdef|drive");
        // A folder grant's "drive" is its granted folder.
        assert_eq!(
            star_key(owner, hash, &StarItem::Path("Shared/Team".into())),
            "5Own|0123456789abcdef|d:Shared/Team"
        );
    }

    #[test]
    fn ids_hashes_and_paths_are_checked_before_they_reach_the_server() {
        assert_eq!(normalize_file_id(&"AB".repeat(32)), Some("ab".repeat(32)));
        assert_eq!(normalize_file_id("abc"), None);
        assert_eq!(normalize_file_id(&"zz".repeat(32)), None);
        assert!(is_folder_hash("0123456789abcdef"));
        assert!(!is_folder_hash("0123"));
        assert_eq!(normalize_path("/A//B/").as_deref(), Some("A/B"));
        assert_eq!(normalize_path("").as_deref(), Some(""));
        assert_eq!(normalize_path("A/../B"), None);
        assert_eq!(normalize_path("A\\B"), None);
    }

    #[test]
    fn a_listing_page_reads_every_kind_and_files_fall_back_to_the_path_hash() {
        let page: FavoritesPage = serde_json::from_value(serde_json::json!({
            "ss58_address": "5Me",
            "drives": [{ "owner_ss58": "5Me", "folder_hash": "0123456789abcdef", "label": "Photos", "file_count": 2,
                         "total_bytes": 10, "created_at": 1, "updated_at": 2, "device_name": "x", "mutation_seq": 1, "favorite": true }],
            "folders": [{ "owner_ss58": "5Me", "folder_hash": "0123456789abcdef", "path": "A/B", "name": "B",
                          "file_count": 1, "total_bytes": 5, "created_at": 0, "favorite": true }],
            "files": [
                { "owner_ss58": "5Me", "folder_hash": "0123456789abcdef", "file_id": "CD".repeat(32), "file_name": "x.pdf",
                  "relative_path": "A/x.pdf", "size_bytes": 3, "created_at": 7, "favorite": true, "path_hash": vec![1; 32] },
                { "owner_ss58": "5Me", "folder_hash": "0123456789abcdef", "path_hash": vec![2; 32], "file_name": "y.pdf",
                  "relative_path": null, "size_bytes": 4, "created_at": 8 }
            ],
            "total_count": 4, "has_more": false, "offset": 0, "limit": 200
        }))
        .expect("page parses");
        assert_eq!(page.len(), 4);
        assert_eq!(page.files[0].id(), Some("cd".repeat(32)), "file_id wins and is lowercased");
        assert_eq!(page.files[1].id(), Some("02".repeat(32)), "path_hash is the fallback");
        assert_eq!(page.files[1].relative_path, None);
        assert_eq!(page.folders[0].created_at, Some(0));
    }

    #[test]
    fn refusals_read_every_envelope_and_full_has_its_own_sentence() {
        let full = FavoriteRefusal::from_body(409, r#"{"Error":{"error":"favorites_full","message":"x"}}"#);
        assert!(full.is_full());
        assert_eq!(failure_sentence(Some(&full), "a.pdf", true), FULL_SENTENCE);
        // Unstarring never reports the cap.
        assert_eq!(failure_sentence(Some(&full), "a.pdf", false), "Couldn't unstar \"a.pdf\". Try again.");
        let coded = FavoriteRefusal::from_body(403, r#"{"Error":{"code":"forbidden"}}"#);
        assert_eq!(coded.code.as_deref(), Some("forbidden"));
        let flat = FavoriteRefusal::from_body(404, r#"{"error":"not_found","message":"x"}"#);
        assert_eq!(flat.code.as_deref(), Some("not_found"));
        assert_eq!(failure_sentence(Some(&flat), "Docs", true), "Couldn't star \"Docs\". Try again.");
        assert!(FavoriteRefusal::no_answer().is_retryable());
        assert!(!full.is_retryable());
    }
}

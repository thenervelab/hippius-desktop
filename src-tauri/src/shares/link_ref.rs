//! Which link an email gate or NDA call is for: a file link, named by its
//! token, or a folder link, named by its listing's token hash.
//!
//! Folder links take the file link's email gate and NDA text (hcfs #1414),
//! with the same bodies and answers. Their owner routes are named by the
//! link's token hash, which every device of the owner's knows, rather than by
//! its token:
//!
//! ```text
//! PUT|GET|DELETE /v1/folder-shares/by-hash/{token_hash}/gate
//! PUT|DELETE     /v1/folder-shares/by-hash/{token_hash}/nda
//! GET            /v1/folder-shares/by-hash/{token_hash}/nda/accepts
//! ```
//!
//! Whatever is sealed for a folder link (the gate's lists, the NDA text) is
//! bound to that hash, as the console seals it, so either app opens it.

use serde::Deserialize;

use super::capabilities::ServerCapabilities;
use crate::error::{AppError, Result};

/// The kind of link, as the frontend names it. Absent means a file link, so
/// every caller from before folder links reads as it did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    #[default]
    File,
    Folder,
}

/// One link, as the gate and NDA routes address it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRef<'a> {
    /// A file link's token.
    File(&'a str),
    /// A folder link's token hash (64 lowercase hex characters).
    Folder(&'a str),
}

const NOT_A_LINK: &str = "That link isn't valid.";

impl<'a> LinkRef<'a> {
    /// `id` named as `kind` says, checked so it can only ever reach its own
    /// link's routes.
    pub fn new(kind: Option<LinkKind>, id: &'a str) -> Result<Self> {
        match kind.unwrap_or_default() {
            LinkKind::File => Ok(Self::File(super::insights::path_segment(id)?)),
            LinkKind::Folder => Ok(Self::Folder(checked_hash(id)?)),
        }
    }

    /// What the link's sealed copies are bound to: the token, or the hash.
    #[must_use]
    pub const fn id(self) -> &'a str {
        match self {
            Self::File(id) | Self::Folder(id) => id,
        }
    }

    #[must_use]
    pub const fn is_folder(self) -> bool {
        matches!(self, Self::Folder(_))
    }

    /// `/v1/shares/{token}{rest}` or `/v1/folder-shares/by-hash/{hash}{rest}`.
    #[must_use]
    pub fn path(self, rest: &str) -> String {
        match self {
            Self::File(token) => format!("/v1/shares/{token}{rest}"),
            Self::Folder(hash) => format!("/v1/folder-shares/by-hash/{hash}{rest}"),
        }
    }

    /// The server has email gates for this kind of link.
    #[must_use]
    pub const fn gates_on(self, caps: &ServerCapabilities) -> bool {
        match self {
            Self::File(_) => caps.share_gates,
            Self::Folder(_) => caps.folder_share_gates,
        }
    }

    /// The server has NDA texts for this kind of link.
    #[must_use]
    pub const fn nda_on(self, caps: &ServerCapabilities) -> bool {
        match self {
            Self::File(_) => caps.share_nda,
            Self::Folder(_) => caps.folder_share_nda,
        }
    }
}

/// A listing `token_hash`: 64 lowercase hex characters.
pub fn checked_hash(token_hash: &str) -> Result<&str> {
    let ok = token_hash.len() == 64 && token_hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if ok {
        Ok(token_hash)
    } else {
        Err(AppError::Validation(NOT_A_LINK.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn absent_kind_is_a_file_link() {
        assert_eq!(LinkRef::new(None, "tok_1").unwrap(), LinkRef::File("tok_1"));
        assert_eq!(LinkRef::new(Some(LinkKind::Folder), HASH).unwrap(), LinkRef::Folder(HASH));
        let kind: LinkKind = serde_json::from_str("\"folder\"").unwrap();
        assert_eq!(kind, LinkKind::Folder);
    }

    #[test]
    fn each_kind_reaches_only_its_own_routes() {
        assert_eq!(LinkRef::File("tok_1").path("/gate"), "/v1/shares/tok_1/gate");
        assert_eq!(
            LinkRef::Folder(HASH).path("/nda/accepts"),
            format!("/v1/folder-shares/by-hash/{HASH}/nda/accepts")
        );
        for bad in ["", "../x", "tok/1", "tok?a=1"] {
            assert!(LinkRef::new(None, bad).is_err(), "{bad:?} is refused");
        }
        for bad in ["tok_1", &HASH.to_uppercase(), &HASH[1..], &format!("{HASH}/gate")] {
            assert!(LinkRef::new(Some(LinkKind::Folder), bad).is_err(), "{bad:?} is refused as a folder link");
        }
    }

    #[test]
    fn each_kind_reads_its_own_capability() {
        let caps = ServerCapabilities {
            share_gates: true,
            share_nda: false,
            folder_share_gates: false,
            folder_share_nda: true,
            ..ServerCapabilities::default()
        };
        assert!(LinkRef::File("t").gates_on(&caps));
        assert!(!LinkRef::Folder(HASH).gates_on(&caps));
        assert!(!LinkRef::File("t").nda_on(&caps));
        assert!(LinkRef::Folder(HASH).nda_on(&caps));
    }
}

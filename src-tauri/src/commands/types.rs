use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct CidInfo {
    pub cid: String,
    pub filename: String,
    pub size_bytes: usize,
    pub encrypted: bool,
    pub size_formatted: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChunkInfo {
    pub name: String,
    pub path: String,
    pub original_chunk: usize,
    pub share_idx: usize,
    pub size: usize,
    pub cid: CidInfo,
}

#[derive(Serialize, Deserialize)]
pub struct Metadata {
    pub original_file: OriginalFileInfo,
    pub erasure_coding: ErasureCodingInfo,
    pub chunks: Vec<ChunkInfo>,
    pub metadata_cid: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OriginalFileInfo {
    pub name: String,
    pub size: usize,
    pub hash: String,
    pub extension: String,
}

#[derive(Serialize, Deserialize,Clone)]
pub struct ErasureCodingInfo {
    pub k: usize,
    pub m: usize,
    pub chunk_size: usize,
    pub encrypted: bool,
    pub file_id: String,
    pub encrypted_size: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub file_name: String,
    pub file_size: usize,
    pub cid: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderReference {
    pub cid: String,
    #[serde(alias = "filename", alias = "file_name")]
    pub file_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderFileEntry {
    #[serde(alias = "filename", alias = "file_name")]
    pub file_name: String,
    #[serde(default)]
    pub file_size: Option<usize>,
    pub cid: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileDetail {
    pub file_name: String,
    pub cid: String,
    pub source: String,
    pub file_hash: String,
    pub miner_ids: String,
    pub file_size: u64, // <-- FIX: Changed to u64
    pub created_at: String,
    pub last_charged_at: String,
    pub is_folder: bool, // <-- FIX: Added this field
}


#[derive(Serialize, Deserialize)]
struct FolderMetadata {
    version: u32,
    files: Vec<FileEntry>,
    erasure_info: Option<ErasureCodingInfo>, // Only for encrypted folders
    encrypted: bool,
    original_folder_name: String,
}
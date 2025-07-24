use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct CidInfo {
    pub cid: String,
    pub filename: String,
    pub size_bytes: usize,
    pub encrypted: bool,
    pub size_formatted: String,
}

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
pub struct OriginalFileInfo {
    pub name: String,
    pub size: usize,
    pub hash: String,
    pub extension: String,
}

#[derive(Serialize, Deserialize)]
pub struct ErasureCodingInfo {
    pub k: usize,
    pub m: usize,
    pub chunk_size: usize,
    pub encrypted: bool,
    pub file_id: String,
    pub encrypted_size: usize,
}

pub const DEFAULT_K: usize = 3;
pub const DEFAULT_M: usize = 5;
pub const DEFAULT_CHUNK_SIZE: usize = 1024 * 1024; // 1MB

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub file_name: String,
    pub file_size: usize,
    pub cid: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileDetail {
    pub file_name: String,
    pub cid: String,
    pub source: String,
    pub file_hash: String,
    pub miner_ids: String,
    pub file_size: usize,
    pub created_at: String,
    pub last_charged_at: String,
}

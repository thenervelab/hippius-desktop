use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct ChunkInfo {
    pub name: String,
    pub cid: String,
    pub original_chunk: usize,
    pub share_idx: usize,
    pub size: usize,
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
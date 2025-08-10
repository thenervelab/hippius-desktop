use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct FolderNode {
    pub name: String,
    pub path: PathBuf,
    pub files: Vec<PathBuf>,
    pub children: Vec<FolderNode>,
}

impl FolderNode {
    pub fn build_tree(root: &Path) -> std::io::Result<FolderNode> {
        let mut node = FolderNode {
            name: root.file_name().unwrap().to_string_lossy().to_string(),
            path: root.to_path_buf(),
            files: Vec::new(),
            children: Vec::new(),
        };
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if name.starts_with('.') {
                    continue; // Skip hidden files and directories
                }
            }
            if path.is_dir() {
                node.children.push(FolderNode::build_tree(&path)?);
            } else {
                node.files.push(path);
            }
        }
        Ok(node)
    }
}

// Helper to flatten all files/folders for request CID, but preserve tree for metadata
pub fn flatten_files_and_folders(node: &FolderNode, files: &mut Vec<PathBuf>, folders: &mut Vec<PathBuf>) {
    folders.push(node.path.clone());
    for file in &node.files {
        files.push(file.clone());
    }
    for child in &node.children {
        flatten_files_and_folders(child, files, folders);
    }
}

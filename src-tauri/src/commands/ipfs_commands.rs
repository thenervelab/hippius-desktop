use crate::utils::binary::{
    download_and_decrypt_file_blocking, get_key_for_account, generate_and_store_key_for_account, 
    upload_to_ipfs, init_key_storage
};
use std::fs;
use base64::{engine::general_purpose, Engine as _};
use sodiumoxide::crypto::secretbox;

#[tauri::command]
pub async fn encrypt_and_upload_file(account_id: String, file_path: String, api_url: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        init_key_storage();

        // Get or generate key
        let key_b64 = get_key_for_account(&account_id)
            .unwrap_or_else(|| generate_and_store_key_for_account(&account_id));
        let key_bytes = general_purpose::STANDARD.decode(&key_b64).map_err(|e| e.to_string())?;
        let key = secretbox::Key::from_slice(&key_bytes).ok_or("Key must be 32 bytes")?;

        // Read file
        let file_data = fs::read(&file_path).map_err(|e| e.to_string())?;

        // Encrypt
        let nonce = secretbox::gen_nonce();
        let encrypted_data = secretbox::seal(&file_data, &nonce, &key);

        // Save nonce + encrypted data (for upload)
        let mut to_upload = nonce.0.to_vec();
        to_upload.extend_from_slice(&encrypted_data);

        // Write encrypted data to a temp file
        let temp_path = std::env::temp_dir().join("encrypted_upload.bin");
        fs::write(&temp_path, &to_upload).map_err(|e| e.to_string())?;

        // Upload to IPFS
        let cid = upload_to_ipfs(&api_url, temp_path.to_str().unwrap())
            .map_err(|e| e.to_string())?;
        println!("Encrypted file uploaded to IPFS with CID: {}", cid);

        // Optionally, remove the temp file
        let _ = fs::remove_file(&temp_path);

        Ok(cid)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_and_decrypt_file(account_id: String, cid: String, api_url: String) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        download_and_decrypt_file_blocking(account_id, cid, api_url)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| e.to_string())
}
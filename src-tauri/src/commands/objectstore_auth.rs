use crate::utils::objectstore_tokens::{
    clear_objectstore_env, ensure_master_token_env, get_temp_auth_key, save_master_token,
    save_temp_auth_key, has_master_token,
};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.hippius.com/api";

#[derive(Deserialize, Serialize, Debug)]
pub struct MasterTokenResponse {
    #[serde(rename = "accessKeyId")]
    pub access_key_id: String,
    #[serde(rename = "secret")]
    pub secret: String,
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
struct CreateMasterTokenBody<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<&'a str>,
}

#[tauri::command]
pub async fn save_temp_auth_key_command(account_id: String, temp_auth_key: String) -> Result<(), String> {
    println!("[Auth] Master Token for {}:{}", account_id, temp_auth_key);
    save_temp_auth_key(&account_id, &temp_auth_key).await
}

#[tauri::command]
pub async fn request_master_token_command(
    account_id: String,
    temp_auth_key: Option<String>,
) -> Result<MasterTokenResponse, String> {
    let key_to_use = match temp_auth_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => get_temp_auth_key(&account_id)
            .await?
            .ok_or_else(|| "No temporary auth key stored; pass one to this command".to_string())?,
    };

    let client = reqwest::Client::new();
    let url = format!("{}/objectstore/master-tokens/", API_BASE);
    let body = CreateMasterTokenBody {
        name: "hippius-desktop",
        expires_at: None,
    };

    let resp = client
        .post(&url)
        .header(AUTHORIZATION, format!("Token {}", key_to_use))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to call master-tokens API: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Master token request failed (status {}): {}",
            status, text
        ));
    }

    let parsed: MasterTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse master token response: {}", e))?;

    save_master_token(&account_id, &parsed.access_key_id, &parsed.secret).await?;
    // Immediately place into environment for S3 client use
    let _ = ensure_master_token_env(&account_id).await;

    Ok(parsed)
}

#[tauri::command]
pub async fn has_master_token_command(account_id: String) -> Result<bool, String> {
    has_master_token(&account_id).await
}

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug)]
pub struct IpfsInfo {
    pub ID: Option<String>,
    pub Addresses: Option<Vec<String>>,
    pub AgentVersion: Option<String>,
    pub ProtocolVersion: Option<String>,
}

#[tauri::command]
pub async fn get_ipfs_node_info() -> Result<IpfsInfo, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    // Get the IPFS node URL from environment or config
    let ipfs_url = std::env::var("IPFS_NODE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5001".to_string());
    
    let url = format!("{}/api/v0/id", ipfs_url);
    
    // Make the POST request
    let response = client.post(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    
    let ipfs_info: IpfsInfo = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    Ok(ipfs_info)
}

#[tauri::command]
pub async fn get_ipfs_bandwidth() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    
    // Get the IPFS node URL from environment or config
    let ipfs_url = std::env::var("IPFS_NODE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5001".to_string());
    
    let url = format!("{}/api/v0/stats/bw", ipfs_url);
    
    // Make the POST request
    let response = client.post(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    
    let data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    Ok(data)
}

#[tauri::command]
pub async fn get_ipfs_peers() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    
    // Get the IPFS node URL from environment or config
    let ipfs_url = std::env::var("IPFS_NODE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5001".to_string());
    
    let url = format!("{}/api/v0/swarm/peers", ipfs_url);
    
    // Make the POST request
    let response = client.post(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    
    let data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    Ok(data)
}

pub async fn get_ipfs_file_size(cid: &str) -> Result<u64, String> {
    let api_url = std::env::var("IPFS_NODE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5001".to_string());
    
    // Strip any /ipfs/ prefix if present
    let cid = cid.trim_start_matches("/ipfs/");
    
    let url = format!("{}/api/v0/dag/stat?arg={}", api_url, cid);
    
    let client = reqwest::Client::new();
    let response = client.post(&url)
        .header("Content-Type", "application/json")
        .body("{}") // Some IPFS nodes require a body for POST requests
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("Request timed out for CID: {}", cid)
            } else if e.is_connect() {
                format!("Connection error for CID: {} - Check IPFS node URL", cid)
            } else {
                format!("Failed to send request for CID: {} - Error: {}", cid, e)
            }
        })?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "IPFS API error for CID: {} - Response: {}",
            cid,
            body
        ));
    }

    let body = response.text().await.map_err(|e| {
        format!("Failed to read response body for CID {}: {}", cid, e)
    })?;

    // Try both JSON parsing approaches for robustness
    // First try proper JSON parsing
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(size) = parsed["Size"].as_u64() {
            return Ok(size);
        }
        if let Some(size) = parsed["CumulativeSize"].as_u64() {
            return Ok(size);
        }
    }

    // Fallback to string parsing if JSON parsing fails
    if let Some(size_start) = body.find("\"Size\":") {
        let size_str = &body[size_start + 7..];
        if let Some(size_end) = size_str.find(',') {
            if let Ok(size) = size_str[..size_end].trim().parse::<u64>() {
                return Ok(size);
            }
        }
    }

    Err(format!(
        "Could not determine file size from IPFS response for CID: {}. Response was: {}",
        cid, body
    ))
}
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    let url = format!("{}/api/v0/ls?arg={}", api_url, cid);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    let body = resp.text().await.map_err(|e| e.to_string())?;

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse IPFS ls response: {}", e))?;

    let size = parsed["Objects"]
        .as_array()
        .and_then(|objs| objs.first())
        .and_then(|obj| obj["Links"].as_array())
        .and_then(|links| links.first())
        .and_then(|link| link["Size"].as_u64())
        .ok_or_else(|| "File size not found".to_string())?;

    Ok(size)
}

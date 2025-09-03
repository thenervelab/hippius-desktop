use reqwest::blocking::multipart;
use reqwest::blocking::Client;
// use reqwest::Client as RequestClient;
use serde_json;
use std::fs;
use std::io::Read;

pub fn upload_to_ipfs(
    api_url: &str,
    file_path: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = Client::new();

    // Read file data
    let mut file = fs::File::open(file_path)?;
    let mut file_data = Vec::new();
    file.read_to_end(&mut file_data)?;

    let part = multipart::Part::bytes(file_data)
        .file_name("file")
        .mime_str("application/octet-stream")?;
    let form = multipart::Form::new().part("file", part);

    // Use cid-version=1
    let res = client
        .post(&format!(
            "{}/api/v0/add?cid-version=1&raw-leaves=true",
            api_url
        ))
        .multipart(form)
        .send()?
        .error_for_status()?;

    // Parse response
    let json: serde_json::Value = res.json()?;
    let cid = json["Hash"]
        .as_str()
        .ok_or("No Hash in IPFS response")?
        .to_string();

    // Pin the file to the local node
    let pin_url = format!("{}/api/v0/pin/add?arg={}", api_url, cid);
    let pin_res = client.post(&pin_url).send();
    match pin_res {
        Ok(resp) => {},
        Err(e) => {
            println!("[IPFS] Error pinning CID {}: {}", cid, e);
        }
    }

    Ok(cid)
}

pub fn download_from_ipfs(api_url: &str, cid: &str) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let client = Client::new();

    let res = client
        .post(&format!("{}/api/v0/cat?arg={}", api_url, cid))
        .send()?
        .error_for_status()?;

    let bytes = res.bytes()?.to_vec();
    Ok(bytes)
}

pub async fn download_from_ipfs_async(api_url: &str, cid: &str) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    let res = client
        .post(&format!("{}/api/v0/cat?arg={}", api_url, cid))
        .send()
        .await?
        .error_for_status()?;
        println!("IPFS response status for CID {}: {}", cid, res.status());
    let bytes = res.bytes().await?.to_vec();
    Ok(bytes)
}

pub async fn download_content_from_ipfs(api_url: &str, cid: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(&format!("{}/api/v0/cat?arg={}", api_url, cid))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok(bytes)
}

pub async fn upload_bytes_to_ipfs(
    api_url: &str,
    data: Vec<u8>,
    filename: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let part = reqwest::multipart::Part::bytes(data)
        .file_name(filename.to_owned())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new().part("file", part);

    // Force CIDv1 with raw-leaves for modern compatibility
    let url = format!(
        "{}/api/v0/add?cid-version=1&raw-leaves=true",
        api_url
    );

    let res = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?
        .error_for_status()
        .map_err(|e| format!("IPFS returned error: {}", e))?;

    let body = res.text().await.map_err(|e| format!("Failed to read response: {}", e))?;

    let ipfs_res: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse JSON: {} | Body: {}", e, body))?;

    ipfs_res.get("Hash")
        .or_else(|| ipfs_res.get("Cid")) // Fallback if future node returns "Cid"
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Failed to parse CID from response: {}", body))
}

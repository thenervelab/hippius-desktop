use reqwest::blocking::multipart;
use reqwest::blocking::Client;
use reqwest::Client as RequestClient;
use serde_json;
use std::fs;
use std::io::Read;

pub fn upload_to_ipfs(
    api_url: &str,
    file_path: &str,
) -> Result<String, Box<dyn std::error::Error>> {
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
        Ok(resp) => {
            if resp.status().is_success() {
                println!("[IPFS] Successfully pinned CID: {}", cid);
            } else {
                println!(
                    "[IPFS] Failed to pin CID: {} (status: {})",
                    cid,
                    resp.status()
                );
            }
        }
        Err(e) => {
            println!("[IPFS] Error pinning CID {}: {}", cid, e);
        }
    }

    Ok(cid)
}


pub fn download_from_ipfs(api_url: &str, cid: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let client = Client::new();

    let res = client
        .post(&format!("{}/api/v0/cat?arg={}", api_url, cid))
        .send()?
        .error_for_status()?;

    let bytes = res.bytes()?.to_vec();
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

pub async fn pin_json_to_ipfs_local(json_string: &str, api_url: &str) -> Result<String, String> {
    let url = format!("{}/api/v0/add?cid-version=1", api_url);
    let client = RequestClient::new();
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::text(json_string.to_owned())
            .file_name("data.json")
            .mime_str("application/json")
            .unwrap(),
    );

    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Unexpected status code: {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if let Some(cid_str) = body["Hash"].as_str() {
        Ok(cid_str.to_string())
    } else {
        Err("No CID found in response".to_string())
    }
}

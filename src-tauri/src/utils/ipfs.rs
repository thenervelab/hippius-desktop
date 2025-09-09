use reqwest::blocking::Client;


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
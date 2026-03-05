use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize, Debug)]
pub struct IpfsInfo {
    #[serde(rename = "ID")]
    pub id: Option<String>,
    #[serde(rename = "Addresses")]
    pub addresses: Option<Vec<String>>,
    #[serde(rename = "AgentVersion")]
    pub agent_version: Option<String>,
    #[serde(rename = "ProtocolVersion")]
    pub protocol_version: Option<String>,
}

// returning haedcoded values for now untils graph is removed from frontend
#[tauri::command]
pub async fn get_ipfs_node_info() -> Result<IpfsInfo, String> {
    // Return hardcoded node info
    Ok(IpfsInfo {
        id: Some("QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN".to_string()),
        addresses: Some(vec![
            "/ip4/127.0.0.1/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN"
                .to_string(),
            "/ip4/192.168.1.100/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN"
                .to_string(),
        ]),
        agent_version: Some("kubo/0.35.0/8d00929".to_string()),
        protocol_version: Some("ipfs/0.1.0".to_string()),
    })
}

#[tauri::command]
pub async fn get_ipfs_bandwidth() -> Result<serde_json::Value, String> {
    // Return hardcoded bandwidth stats
    Ok(json!({
        "TotalIn": 123456789,
        "TotalOut": 987654321,
        "RateIn": 1234.56,
        "RateOut": 5678.90
    }))
}

#[tauri::command]
pub async fn get_ipfs_peers() -> Result<serde_json::Value, String> {
    // Return hardcoded peers list
    Ok(json!([
        {
            "Addr": "/ip4/1.2.3.4/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
            "Peer": "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
            "Latency": "35.2ms",
            "Muxer": "/mplex/6.7.0",
            "Streams": null
        },
        {
            "Addr": "/ip4/5.6.7.8/tcp/4001/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
            "Peer": "QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
            "Latency": "42.1ms",
            "Muxer": "/mplex/6.7.0",
            "Streams": null
        }
    ]))
}

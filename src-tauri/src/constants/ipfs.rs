use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum IpfsProgress {
    CheckingBinary,
    StartingDaemon,
    ConnectingToNetwork,
    Ready,
}

pub const KUBO_VERSION: &str = "0.35.0";

pub const IPFS_NODE_SETUP_EVENT: &str = "ipfs_node_setup";

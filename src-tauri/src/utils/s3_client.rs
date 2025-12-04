use aws_config::{BehaviorVersion, stalled_stream_protection::StalledStreamProtectionConfig};
use aws_sdk_s3::{config::Region, Client};
use crate::utils::objectstore_tokens::ensure_master_token_or_fetch;
use crate::utils::sync::current_account_id;

const S3_ENDPOINT: &str = "https://s3.hippius.com";
const S3_REGION: &str = "us-east-1";

pub async fn make_s3_client() -> Client {
    // Ensure AWS_* env vars are populated from the stored master token if present.
    if let Ok(active_account) = current_account_id() {
        if let Err(e) = ensure_master_token_or_fetch(&active_account).await {
            eprintln!(
                "[S3] No stored master token yet or fetch failed for {} ({}); using existing AWS env vars if any",
                active_account, e
            );
        }
    } else {
        eprintln!("[S3] No active account set; using existing AWS env vars if any");
    }

    let shared = aws_config::defaults(BehaviorVersion::latest())
        .stalled_stream_protection(StalledStreamProtectionConfig::disabled())
        .load()
        .await;
    let conf = aws_sdk_s3::config::Builder::from(&shared)
        .region(Region::new(S3_REGION))
        .endpoint_url(S3_ENDPOINT)
        .force_path_style(true)
        .build();
    Client::from_conf(conf)
}

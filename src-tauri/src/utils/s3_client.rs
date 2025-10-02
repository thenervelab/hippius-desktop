use aws_config::{BehaviorVersion, stalled_stream_protection::StalledStreamProtectionConfig};
use aws_sdk_s3::{Client, config::Region};

const S3_ENDPOINT: &str = "https://s3.hippius.com";
const S3_REGION: &str = "us-east-1";

pub async fn make_s3_client() -> Client {
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

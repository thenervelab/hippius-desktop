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

// NOTE, update the one in the JS side too when this is updated.
// app/lib/constants/appSetupPhases.ts
pub const APP_SETUP_EVENT: &str = "app_setup_event";

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AppSetupPhase {
    CheckingBinary,
    DownloadingBinary,
    ConfiguringCors,
    StartingDaemon,
    ConnectingToNetwork,
    InitialisingDatabase,
    SyncingData,
    Ready,
}

pub const KUBO_VERSION: &str = "0.35.0";

// NOTE, update the one in the JS side too when this is updated.
// app/lib/constants/appSetupPhases.ts
pub const APP_SETUP_EVENT: &str = "app_setup_event";
pub const API_URL: &str = "http://127.0.0.1:5001"; // Or use from config/constants

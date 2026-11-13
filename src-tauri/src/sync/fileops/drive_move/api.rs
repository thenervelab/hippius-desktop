//! HTTP calls for one move between drives.
//!
//! hcfs-client has no drive-move methods, so these are direct `reqwest`
//! calls with `Authorization: Bearer`, the way the shared-drive commands
//! call their routes. The copy sessions' chunk PUTs and finalize go through
//! the ordinary upload-session routes, called here too and against the SAME
//! base URL as the move: a session lives on the server that opened it, and
//! hcfs-client's own client picks its region by racing, so mixing the two
//! could send a chunk to a server that never saw the session.
//!
//! Every function takes the client, base and bearer as values so the
//! mock-server tests (`tests/drive_move_server_mock.rs`) drive the real
//! request and response code with no Tauri runtime.

use super::wire::{
    CommitDriveMoveRequest, CommitDriveMoveResult, CreateDriveMoveRequest, CreateDriveMoveResult, MoveRefusal, StageMoveSessionRequest, StagedSession,
};
use hcfs_shared::network::NetworkResponse;
use serde::de::DeserializeOwned;
use std::time::Duration;

/// Bound on the small JSON calls. A chunk PUT gets longer (see
/// [`CHUNK_TIMEOUT`]); a commit locks and rewrites up to 2,000 files.
const CALL_TIMEOUT: Duration = Duration::from_mins(1);
/// An 8 MiB chunk on a slow uplink.
const CHUNK_TIMEOUT: Duration = Duration::from_mins(5);
/// A commit or finalize is retried this many times in all when no answer
/// arrives: a repeated commit answers the first commit's result, so asking
/// again is how a lost answer is recovered.
const ATTEMPTS: u32 = 3;

/// Where and as whom a move talks to the server.
#[derive(Clone)]
pub struct MoveApi {
    pub http: reqwest::Client,
    pub base_url: String,
    pub bearer: String,
}

impl MoveApi {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    async fn post_json<B: serde::Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T, MoveRefusal> {
        let response = self
            .http
            .post(self.url(path))
            .bearer_auth(&self.bearer)
            .timeout(CALL_TIMEOUT)
            .json(body)
            .send()
            .await
            .map_err(|e| {
                tracing::debug!(path, error = %e, "drive move: no answer");
                MoveRefusal::no_answer()
            })?;
        read_envelope(response).await
    }

    /// `POST /v1/drive_moves`.
    pub async fn open(&self, request: &CreateDriveMoveRequest) -> Result<CreateDriveMoveResult, MoveRefusal> {
        self.post_json("/v1/drive_moves", request).await
    }

    /// `POST /v1/drive_moves/{move_id}/sessions`: the copy's session id.
    pub async fn open_copy_session(&self, move_id: &str, request: &StageMoveSessionRequest) -> Result<StagedSession, MoveRefusal> {
        self.post_json(&format!("/v1/drive_moves/{move_id}/sessions"), request).await
    }

    /// `PUT /upload/session/{id}/chunk/{index}`, retried on no answer, a 5xx
    /// or a 429, as the engine retries its own chunk PUTs.
    pub async fn put_chunk(&self, session_id: &str, index: u32, chunk: bytes::Bytes) -> Result<(), MoveRefusal> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let sent = self
                .http
                .put(self.url(&format!("/upload/session/{session_id}/chunk/{index}")))
                .bearer_auth(&self.bearer)
                .timeout(CHUNK_TIMEOUT)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(chunk.clone())
                .send()
                .await;
            let refusal = match sent {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => {
                    let status = response.status().as_u16();
                    MoveRefusal::from_body(status, &response.text().await.unwrap_or_default())
                }
                Err(e) => {
                    tracing::debug!(index, error = %e, "drive move: chunk PUT got no answer");
                    MoveRefusal::no_answer()
                }
            };
            if !refusal.is_retryable() || attempt >= ATTEMPTS {
                return Err(refusal);
            }
            tokio::time::sleep(backoff(attempt)).await;
        }
    }

    /// `POST /upload/session/{id}/finalize`, which STAGES a copy session's
    /// file. Retried when no answer arrives; a resent finalize of a copy
    /// already staged answers `already_staged`, which is read as success.
    pub async fn finalize(&self, session_id: &str) -> Result<(), MoveRefusal> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let result: Result<serde_json::Value, MoveRefusal> = self
                .post_json(&format!("/upload/session/{session_id}/finalize"), &serde_json::json!({}))
                .await;
            match result {
                Ok(_) => return Ok(()),
                Err(refusal) if attempt > 1 && refusal.code.as_deref() == Some("already_staged") => return Ok(()),
                Err(refusal) if refusal.is_retryable() && attempt < ATTEMPTS => tokio::time::sleep(backoff(attempt)).await,
                Err(refusal) => return Err(refusal),
            }
        }
    }

    /// `POST /v1/drive_moves/{move_id}/commit`, asked again when no answer
    /// arrives: a repeated commit answers the first one's result, so a lost
    /// answer is never mistaken for a refusal.
    pub async fn commit(&self, move_id: &str, request: &CommitDriveMoveRequest) -> Result<CommitDriveMoveResult, MoveRefusal> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.post_json(&format!("/v1/drive_moves/{move_id}/commit"), request).await {
                Err(refusal) if refusal.is_retryable() && attempt < ATTEMPTS => tokio::time::sleep(backoff(attempt)).await,
                other => return other,
            }
        }
    }

    /// `POST /v1/drive_moves/{move_id}/abort`: frees the move's sessions,
    /// copies and quota holds. `204`, also for one already aborted.
    pub async fn abort(&self, move_id: &str) -> Result<(), MoveRefusal> {
        let response = self
            .http
            .post(self.url(&format!("/v1/drive_moves/{move_id}/abort")))
            .bearer_auth(&self.bearer)
            .timeout(CALL_TIMEOUT)
            .send()
            .await
            .map_err(|_| MoveRefusal::no_answer())?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        Err(MoveRefusal::from_body(status.as_u16(), &response.text().await.unwrap_or_default()))
    }
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(500 * u64::from(attempt))
}

/// Read a `NetworkResponse` envelope, or the refusal the body names.
async fn read_envelope<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, MoveRefusal> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| MoveRefusal::no_answer())?;
    if !(200..300).contains(&status) {
        return Err(MoveRefusal::from_body(status, &body));
    }
    match serde_json::from_str::<NetworkResponse<T>>(&body) {
        Ok(NetworkResponse::Success(value)) => Ok(value),
        // A 2xx carrying an error envelope is still a refusal.
        Ok(_) => Err(MoveRefusal::from_body(status, &body)),
        Err(e) => {
            tracing::debug!(error = %e, "drive move: unreadable answer");
            Err(MoveRefusal {
                status,
                ..MoveRefusal::no_answer()
            })
        }
    }
}

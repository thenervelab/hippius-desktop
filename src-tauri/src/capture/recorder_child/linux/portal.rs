//! The desktop's side of a recording, through xdg-desktop-portal: the
//! ScreenCast session on Wayland (the desktop's own dialog chooses a monitor
//! or a window, and hands back a PipeWire stream) and, on both sessions, an
//! Inhibit request so the screen does not blank while recording.
//!
//! The ScreenCast session belongs to this process's D-Bus connection: if the
//! recorder dies, the desktop ends the session and its "sharing" indicator
//! with it. The connection is driven by a small tokio runtime owned here for
//! the recording's lifetime.

use std::os::fd::{AsRawFd, OwnedFd};
use std::time::Duration;

use ashpd::desktop::inhibit::{InhibitFlags, InhibitOptions, InhibitProxy};
use ashpd::desktop::screencast::{CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType, StartCastOptions};
use ashpd::desktop::{CreateSessionOptions, PersistMode, Request, Session};

use super::super::linux_plan::{PortalAsk, VideoSource};
use super::say;
use crate::capture::linux_portal::{PortalAnswer, classify};
use crate::capture::recording::RecordingUnavailable;
use crate::capture::recording::protocol::{PICKER_CANCELLED, StreamPlacement};

/// How long the portal may take to answer a question that shows no dialog
/// (whether it exists, the inhibit).
const QUICK: Duration = Duration::from_secs(5);

/// A ScreenCast session in progress.
struct Cast {
    proxy: Screencast,
    session: Session<Screencast>,
    /// The PipeWire remote; `pipewiresrc` reads the stream through it, so it
    /// stays open until the session closes.
    fd: OwnedFd,
    restore_token: Option<String>,
    /// Where the compositor shows the stream, when it says (a monitor's
    /// place in its logical layout): which monitor a Wayland area's
    /// selection window should cover.
    placement: Option<StreamPlacement>,
}

/// The portal objects of one recording and the runtime that drives them.
pub struct Desktop {
    runtime: tokio::runtime::Runtime,
    cast: Option<Cast>,
    inhibit: Option<Request<()>>,
}

impl Desktop {
    /// # Errors
    /// The runtime could not start (out of threads).
    pub fn new() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("capture-portal")
            .enable_all()
            .build()
            .map_err(|e| format!("could not start the desktop connection: {e}"))?;
        Ok(Self {
            runtime,
            cast: None,
            inhibit: None,
        })
    }

    /// Ask the ScreenCast portal for what `ask` describes (the desktop's
    /// dialog shows unless a restore token brings the choice back) and
    /// answer the picture's source.
    ///
    /// # Errors
    /// [`PICKER_CANCELLED`] when the user closed the dialog; the portal line
    /// when there is no portal; otherwise a sentence with the detail logged.
    pub fn open_screencast(&mut self, ask: &PortalAsk) -> Result<VideoSource, String> {
        let opened = self.runtime.block_on(start_cast(ask));
        let cast = opened.map_err(|e| match classify(&e) {
            PortalAnswer::Cancelled => PICKER_CANCELLED.to_string(),
            PortalAnswer::Missing => RecordingUnavailable::PortalMissing.message().to_string(),
            PortalAnswer::Failed(detail) | PortalAnswer::Saved(detail) => {
                say(&format!("the screen-sharing portal failed: {detail}"));
                "Your desktop's screen sharing didn't start. Try again.".to_string()
            }
        })?;
        let (cast, node) = cast;
        let source = VideoSource::Portal {
            fd: cast.fd.as_raw_fd(),
            node,
        };
        self.cast = Some(cast);
        Ok(source)
    }

    /// Where the chosen stream sits in the desktop's layout, when the
    /// portal said.
    #[must_use]
    pub fn stream_placement(&self) -> Option<StreamPlacement> {
        self.cast.as_ref().and_then(|c| c.placement)
    }

    /// The token for restoring this choice next time, when the portal gave
    /// one.
    #[must_use]
    pub fn restore_token(&self) -> Option<String> {
        self.cast.as_ref().and_then(|c| c.restore_token.clone())
    }

    /// Keep the screen from blanking while recording. Best effort: a desktop
    /// without the Inhibit portal records all the same.
    pub fn keep_awake(&mut self) {
        let asked = self.runtime.block_on(async {
            tokio::time::timeout(QUICK, async {
                let proxy = InhibitProxy::new().await?;
                proxy
                    .inhibit(
                        None,
                        InhibitFlags::Idle.into(),
                        InhibitOptions::default().set_reason("Hippius is recording the screen"),
                    )
                    .await
            })
            .await
        });
        match asked {
            Ok(Ok(request)) => self.inhibit = Some(request),
            Ok(Err(e)) => say(&format!("the screen may blank while recording (no inhibit portal): {e}")),
            Err(_) => say("the screen may blank while recording (the inhibit portal did not answer)"),
        }
    }

    /// End the screen-sharing session and the inhibit, so the desktop's
    /// indicator goes away with the recording.
    pub fn close(self) {
        let Self { runtime, cast, inhibit } = self;
        runtime.block_on(async {
            if let Some(cast) = cast {
                let _ = tokio::time::timeout(QUICK, cast.session.close()).await;
                drop(cast.proxy);
            }
            if let Some(request) = inhibit {
                let _ = tokio::time::timeout(QUICK, request.close()).await;
            }
        });
        runtime.shutdown_timeout(QUICK);
    }
}

/// The ScreenCast dance: create a session, say what may be chosen, start
/// (the dialog), open the PipeWire remote.
async fn start_cast(ask: &PortalAsk) -> ashpd::Result<(Cast, u32)> {
    let proxy = Screencast::new().await?;
    // The pointer drawn into the picture, as macOS and Windows record it,
    // where the desktop offers that; hidden otherwise rather than drawn as
    // metadata nobody reads.
    let cursor = match proxy.available_cursor_modes().await {
        Ok(modes) if modes.contains(CursorMode::Embedded) => CursorMode::Embedded,
        _ => CursorMode::Hidden,
    };
    let session = proxy.create_session(CreateSessionOptions::default()).await?;
    let kind = if ask.window { SourceType::Window } else { SourceType::Monitor };
    let persist = if ask.persist {
        PersistMode::ExplicitlyRevoked
    } else {
        PersistMode::DoNot
    };
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(cursor)
                .set_sources(ashpd::enumflags2::BitFlags::from(kind))
                .set_multiple(false)
                .set_persist_mode(persist)
                .set_restore_token(ask.restore_token.as_deref()),
        )
        .await?
        .response()?;
    let streams = proxy.start(&session, None, StartCastOptions::default()).await?.response()?;
    let Some(stream) = streams.streams().first() else {
        return Err(ashpd::Error::NoResponse);
    };
    let node = stream.pipe_wire_node_id();
    let placement = match (stream.position(), stream.size()) {
        (Some((x, y)), Some((width, height))) => Some(StreamPlacement { x, y, width, height }),
        _ => None,
    };
    let restore_token = streams.restore_token().map(str::to_string);
    let fd = proxy.open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default()).await?;
    Ok((
        Cast {
            proxy,
            session,
            fd,
            restore_token,
            placement,
        },
        node,
    ))
}

/// Whether a ScreenCast portal answers here (the probe asks once per launch).
#[must_use]
pub fn screencast_available() -> bool {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
        return false;
    };
    runtime.block_on(async {
        tokio::time::timeout(QUICK, async {
            let proxy = Screencast::new().await.ok()?;
            proxy.available_source_types().await.ok()
        })
        .await
        .ok()
        .flatten()
        .is_some_and(|types| types.contains(SourceType::Monitor))
    })
}

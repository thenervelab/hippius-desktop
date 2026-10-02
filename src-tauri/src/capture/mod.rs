//! Screen capture: screenshots and recordings of an area, a window or a whole
//! display, uploaded into the user's drive with a share link copied.
//!
//! Design and phasing: `docs/plans/2026-09-22-screen-capture.md`.

pub mod area_pick;
pub mod bar;
pub mod camera;
pub mod commands;
pub mod deliver;
pub mod desktop_shortcut;
pub mod destination;
pub mod device_watch;
pub mod geometry;
pub mod linux_portal;
pub mod linux_x11;
pub mod mic_meter;
pub mod naming;
pub mod permission_flow;
pub mod permissions;
pub mod poster;
pub mod preview;
pub mod privacy;
pub mod recorder_child;
pub mod recording;
pub mod rollout;
pub mod screencast_token;
pub mod screenshot;
pub mod session;
pub mod share;
pub mod shortcut;
pub mod shortcut_portal;
pub mod support;
pub mod targets;
pub mod thumbnail;
pub mod tray_recording_menu;
pub mod tray_status;
pub mod webview_media;
#[cfg(target_os = "linux")]
mod webview_media_gtk;

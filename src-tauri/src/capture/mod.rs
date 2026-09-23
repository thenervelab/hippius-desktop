//! Screen capture: screenshots and recordings of an area, a window or a whole
//! display, uploaded into the user's drive with a share link copied.
//!
//! Design and phasing: `docs/plans/2026-09-22-screen-capture.md`.

pub mod commands;
pub mod deliver;
pub mod destination;
pub mod geometry;
pub mod naming;
pub mod permissions;
pub mod recording;
pub mod screenshot;
pub mod session;
pub mod targets;

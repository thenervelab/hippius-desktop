//! Wayland: which capture window took the keyboard, and whether the pointer
//! was on it (`own_windows::capture_window_focus_shows_main`).
//!
//! GNOME's dock and Alt+Tab raise the app's first visible window. With the
//! main window hidden for a recording that is the pill or the camera bubble
//! (GTK 3 cannot keep a Wayland window out of the dock), so a dock click on
//! Hippius only focused the pill. A click on the pill focuses it too; the
//! difference is where the pointer is, which GTK's crossing events say
//! without asking the compositor (Wayland gives no global pointer position).
//! A leave towards a child window (`Inferior`, the webview inside the GTK
//! window) is not a leave. The window's map time is kept as well: GNOME
//! focuses a window as it is shown, which is not the user's doing.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use gtk::gdk;
use gtk::prelude::*;
use tauri::Manager;

#[derive(Debug, Default, Clone, Copy)]
struct Watched {
    pointer_over: bool,
    mapped_at: Option<Instant>,
}

static WATCHED: LazyLock<Mutex<HashMap<String, Watched>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_state<T>(label: &str, f: impl FnOnce(&mut Watched) -> T) -> T {
    let mut map = WATCHED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    f(map.entry(label.to_owned()).or_default())
}

/// Follow `window`'s pointer crossings, map and focus. Each window is built
/// once per life, so each GTK window is connected once; a rebuilt window
/// under the same label starts from a fresh state.
pub fn watch(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let posted = window.run_on_main_thread(move || {
        let Ok(gtk_window) = target.gtk_window() else {
            tracing::debug!(window = target.label(), "focus watch: no GTK window");
            return;
        };
        let label = target.label().to_owned();
        // Shown before this ran (the show and this are posted separately):
        // its map counts from now, so the focus GNOME gives it is not taken
        // for the user's.
        let mapped_at = gtk_window.is_mapped().then(Instant::now);
        with_state(&label, |w| {
            *w = Watched {
                pointer_over: false,
                mapped_at,
            };
        });
        gtk_window.add_events(gdk::EventMask::ENTER_NOTIFY_MASK | gdk::EventMask::LEAVE_NOTIFY_MASK | gdk::EventMask::FOCUS_CHANGE_MASK);

        let l = label.clone();
        gtk_window.connect_enter_notify_event(move |_, _| {
            with_state(&l, |w| w.pointer_over = true);
            gtk::glib::Propagation::Proceed
        });
        let l = label.clone();
        gtk_window.connect_leave_notify_event(move |_, event| {
            if event.detail() != gdk::NotifyType::Inferior {
                with_state(&l, |w| w.pointer_over = false);
            }
            gtk::glib::Propagation::Proceed
        });
        let l = label.clone();
        gtk_window.connect_map_event(move |_, _| {
            with_state(&l, |w| w.mapped_at = Some(Instant::now()));
            gtk::glib::Propagation::Proceed
        });
        let app = target.app_handle().clone();
        gtk_window.connect_focus_in_event(move |_, _| {
            let seen = with_state(&label, |w| *w);
            let since_mapped = seen.mapped_at.map(|t| t.elapsed());
            // Acted on outside GTK's handler: showing the main window from
            // inside another window's focus signal is left to the next turn.
            let (app, label) = (app.clone(), label.clone());
            gtk::glib::idle_add_local_once(move || {
                super::commands::on_capture_window_focused(&app, &label, seen.pointer_over, since_mapped);
            });
            gtk::glib::Propagation::Proceed
        });
    });
    if let Err(e) = posted {
        tracing::warn!(error = %e, "focus watch not attached");
    }
}

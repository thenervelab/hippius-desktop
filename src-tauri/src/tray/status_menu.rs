//! macOS: the tray's right-click menu is kept OFF the status item.
//!
//! On newer macOS (seen on macOS 27) a status item that owns a menu
//! (`NSStatusItem.menu`) opens that menu itself on ANY click, left or right,
//! before the `tray-icon` crate's click view (`TaoTrayTarget`, laid over the
//! button) receives the mouse down. So no `TrayIconEvent::Click` ever
//! reached the app, the left click showed the small context menu instead of
//! the popover, and the popover never opened. `showMenuOnLeftClick: false`
//! cannot help: it only decides what the click view does once it gets the
//! event. Hover events (enter/move/leave) still arrive, because they come
//! from the view's tracking area.
//!
//! The menu itself is still made by the main window (`useTraySync.ts`,
//! whose item callbacks and enabled states live there) and attached with the
//! icon. Rust takes it off the status item, keeps it (retained), and opens it
//! on a right click with the same `performClick` the crate itself uses, then
//! takes it off again:
//!
//! - [`tray_menu_attached`]: the page calls it after every `TrayIcon.new` or
//!   `setMenu`, so the menu is detached the moment it is attached;
//! - [`on_tray_event`]: a pointer entering or moving over the icon detaches
//!   whatever menu is there too (a hover always comes before a click), so a
//!   page that forgot to report, or a call that failed, cannot bring the
//!   dead left click back. It is called from the app's ONE tray listener
//!   (`tray::panel::on_tray_icon_event`, registered once in `main.rs`),
//!   before the left-click route: a second registration would handle every
//!   click twice.
//!
//! Windows and Linux are untouched: Windows shows the menu on a right click
//! from its own message loop, and Linux opens it on any click on purpose
//! (see `.claude/rules/tray.md`).

use tauri::AppHandle;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

/// What a tray event asks of the status item's menu. Pure, so the rule is
/// unit-tested without an app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuStep {
    /// Take any menu off the status item (keeping it for a right click).
    Detach,
    /// A right button went down: open the kept menu under the icon.
    PopUp,
    /// Nothing to do (a left click is the popover's, a release, a leave).
    Nothing,
}

/// The step for one tray event.
#[must_use]
pub fn step_for(event: &TrayIconEvent) -> MenuStep {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Right,
            button_state: MouseButtonState::Down,
            ..
        } => MenuStep::PopUp,
        TrayIconEvent::Enter { .. } | TrayIconEvent::Move { .. } => MenuStep::Detach,
        _ => MenuStep::Nothing,
    }
}

/// Apply [`step_for`] to the Hippius icon. Called from the tray listener
/// (`tray::panel::on_tray_icon_event`) for every event of that icon, on the
/// main thread.
pub fn on_tray_event(app: &AppHandle, event: &TrayIconEvent) {
    match step_for(event) {
        MenuStep::Detach => {
            if imp::detach(app) {
                tracing::info!("tray: context menu taken off the status item on hover");
            }
        }
        MenuStep::PopUp => {
            imp::detach(app);
            imp::pop_up(app);
        }
        MenuStep::Nothing => {}
    }
}

/// The main window attached a (new) context menu to the icon, often with a
/// whole new icon (a reload rebuilds it): take the menu off the status item
/// now so the next left click reaches the app (macOS only), and put a
/// running recording's marks back, which the new icon or menu just replaced
/// (`capture::commands::restore_recording_in_tray`, every OS).
#[tauri::command]
pub fn tray_menu_attached(app: AppHandle) {
    if imp::detach(&app) {
        tracing::info!("tray: context menu taken off the status item");
    }
    crate::capture::commands::restore_recording_in_tray(&app);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Mutex;

    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    use tauri::AppHandle;

    use crate::capture::tray_status::TRAY_ID;

    /// The menu taken off the status item, retained (as an address, so the
    /// static is `Send`), `0` when none. Only touched on the main thread,
    /// inside `with_inner_tray_icon`.
    static KEPT_MENU: Mutex<usize> = Mutex::new(0);

    fn kept() -> std::sync::MutexGuard<'static, usize> {
        KEPT_MENU.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Take the status item's menu off it, keeping it. True when there was
    /// one to take.
    pub fn detach(app: &AppHandle) -> bool {
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            return false;
        };
        tray.with_inner_tray_icon(|icon| {
            let Some(item) = icon.ns_status_item() else {
                return false;
            };
            let item = std::ptr::from_ref(&**item).cast::<Object>().cast_mut();
            // SAFETY: the live status item and its menu, on the main thread
            // (`with_inner_tray_icon` runs there). The menu is retained
            // before the item lets go of it, and the menu it replaces is
            // released once, matching its own retain.
            unsafe {
                let menu: *mut Object = msg_send![item, menu];
                if menu.is_null() {
                    return false;
                }
                let _: *mut Object = msg_send![menu, retain];
                let previous = std::mem::replace(&mut *kept(), menu as usize);
                if previous != 0 && previous != menu as usize {
                    let () = msg_send![previous as *mut Object, release];
                } else if previous == menu as usize {
                    // Already kept: drop the extra retain taken above.
                    let () = msg_send![menu, release];
                }
                let nil: *mut Object = std::ptr::null_mut();
                let () = msg_send![item, setMenu: nil];
            }
            true
        })
        .unwrap_or(false)
    }

    /// Open the kept menu under the icon: attach it, click the button the
    /// way `tray-icon` does for a menu (this returns once the menu closes),
    /// and take it off again.
    pub fn pop_up(app: &AppHandle) {
        let menu = *kept();
        if menu == 0 {
            tracing::info!("tray: right click, but no context menu is kept");
            return;
        }
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            return;
        };
        let _ = tray.with_inner_tray_icon(move |icon| {
            let Some(item) = icon.ns_status_item() else {
                return;
            };
            let item = std::ptr::from_ref(&**item).cast::<Object>().cast_mut();
            // SAFETY: as in `detach`; the kept menu stays retained by
            // `KEPT_MENU` while it is shown.
            unsafe {
                let () = msg_send![item, setMenu: menu as *mut Object];
                let button: *mut Object = msg_send![item, button];
                if !button.is_null() {
                    let nil: *mut Object = std::ptr::null_mut();
                    let () = msg_send![button, performClick: nil];
                }
                let nil: *mut Object = std::ptr::null_mut();
                let () = msg_send![item, setMenu: nil];
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;

    pub fn detach(_app: &AppHandle) -> bool {
        false
    }

    pub fn pop_up(_app: &AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::tray::TrayIconId;
    use tauri::{PhysicalPosition, Rect};

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new("hippius-tray"),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        }
    }

    /// A left click is the popover's and must never open the menu; only a
    /// right button going down does.
    #[test]
    fn only_a_right_press_opens_the_menu() {
        assert_eq!(step_for(&click(MouseButton::Right, MouseButtonState::Down)), MenuStep::PopUp);
        assert_eq!(step_for(&click(MouseButton::Right, MouseButtonState::Up)), MenuStep::Nothing);
        assert_eq!(step_for(&click(MouseButton::Left, MouseButtonState::Down)), MenuStep::Nothing);
        assert_eq!(step_for(&click(MouseButton::Left, MouseButtonState::Up)), MenuStep::Nothing);
        assert_eq!(step_for(&click(MouseButton::Middle, MouseButtonState::Down)), MenuStep::Nothing);
    }

    /// The pointer reaches the icon before any click, and hover events still
    /// arrive while a menu sits on the status item: that is when it comes off.
    #[test]
    fn a_hover_takes_the_menu_off_the_status_item() {
        let id = TrayIconId::new("hippius-tray");
        let position = PhysicalPosition::new(0.0, 0.0);
        let rect = Rect::default();
        assert_eq!(
            step_for(&TrayIconEvent::Enter {
                id: id.clone(),
                position,
                rect
            }),
            MenuStep::Detach
        );
        assert_eq!(
            step_for(&TrayIconEvent::Move {
                id: id.clone(),
                position,
                rect
            }),
            MenuStep::Detach
        );
        assert_eq!(step_for(&TrayIconEvent::Leave { id, position, rect }), MenuStep::Nothing);
    }
}

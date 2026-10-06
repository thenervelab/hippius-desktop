//! The capture shortcut on Wayland, through the desktop's GlobalShortcuts
//! portal (KDE Plasma 5.27 and later, GNOME 48 and later, Hyprland).
//!
//! A Wayland app cannot grab keys. The portal lets it ask the desktop for a
//! shortcut instead: Hippius binds one shortcut ([`SHORTCUT_ID`]) with the
//! saved accelerator as its preferred trigger, the desktop may show its own
//! dialog to confirm or change it, and from then on the desktop sends
//! `Activated` when it is pressed, which goes to `commands::on_shortcut`
//! exactly like a press of the plugin's shortcut on X11, macOS or Windows.
//! The desktop owns the binding: Settings shows the desktop's description of
//! the trigger and, where the portal can (interface version 2), opens the
//! desktop's own dialog to change it.
//!
//! The session lives on its own D-Bus connection, registered under the app's
//! id where the portal has the host registry (xdg-desktop-portal 1.19), so
//! the desktop names Hippius in its dialog and keeps its choice per app. One
//! task owns the connection and the session ([`apply`] and [`configure`] only
//! send it commands), so a bind waiting on the desktop's dialog never blocks
//! a command thread. Turning the shortcut off closes the session, which
//! releases the shortcut.
//!
//! Where the portal is missing (GNOME 46 on Ubuntu 24.04, most wlroots
//! desktops) or the lane does not offer it yet (`rollout::Feature::
//! ShortcutPortal`), nothing is bound here and Settings offers the desktop's
//! keyboard settings instead (`desktop_shortcut`).
//!
//! The text conversions are pure and tested on every OS; the D-Bus half is
//! Linux only.

use std::sync::Mutex;

/// The one shortcut Hippius binds; `Activated` for any other id is ignored.
pub const SHORTCUT_ID: &str = "capture";
/// What the desktop's dialog and its keyboard settings call the shortcut.
pub const SHORTCUT_DESCRIPTION: &str = "Open the Hippius capture bar";

/// The desktop's dialog was closed without binding the shortcut.
pub const BIND_DECLINED: &str = "The shortcut wasn't added because the desktop's dialog was closed. Turn it on to be asked again.";
/// The portal answered with an error; the detail is in the log.
pub const BIND_FAILED: &str = "Your desktop didn't add the shortcut. Try turning it off and on again.";

/// Whether this session has the GlobalShortcuts portal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalStatus {
    /// Not asked yet (the probe runs at launch).
    Unknown,
    /// No portal, not Wayland, or the lane does not offer it.
    Missing,
    /// The portal answers. `configurable`: it can open the desktop's own
    /// dialog to change the shortcut (interface version 2).
    Available { configurable: bool },
}

impl PortalStatus {
    #[must_use]
    pub const fn available(self) -> bool {
        matches!(self, Self::Available { .. })
    }
}

/// What the portal last said: whether it exists, how the desktop describes
/// the bound trigger, and why the last bind did not work.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Known {
    status: PortalStatus,
    trigger: Option<String>,
    problem: Option<String>,
}

static KNOWN: Mutex<Known> = Mutex::new(Known {
    status: PortalStatus::Unknown,
    trigger: None,
    problem: None,
});

fn known() -> std::sync::MutexGuard<'static, Known> {
    KNOWN.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether the portal is here, as far as is known.
#[must_use]
pub fn status() -> PortalStatus {
    known().status
}

/// The desktop's description of the bound trigger ("Ctrl+Shift+2"), or
/// `None` while nothing is bound.
#[must_use]
pub fn trigger() -> Option<String> {
    known().trigger.clone()
}

/// Why the last bind did not work, in Rust's words; `None` when it did.
#[must_use]
pub fn problem() -> Option<String> {
    known().problem.clone()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn set_status(status: PortalStatus) {
    known().status = status;
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn set_bound(trigger: Option<String>, problem: Option<&str>) {
    let mut k = known();
    k.trigger = trigger;
    k.problem = problem.map(str::to_string);
}

/// One modifier or key of a Tauri accelerator ("CommandOrControl+Shift+2"),
/// in the "shortcuts" XDG specification's names ("CTRL+SHIFT+2"): the
/// portal's preferred trigger. `None` for a key the specification names in
/// a way not worth guessing; the desktop then picks (or asks for) a key.
#[must_use]
pub fn portal_trigger(accelerator: &str) -> Option<String> {
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for part in accelerator.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let modifier = match part.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "commandorctrl" | "cmdorcontrol" | "control" | "ctrl" => Some("CTRL"),
            "shift" => Some("SHIFT"),
            "alt" | "option" => Some("ALT"),
            "super" | "command" | "cmd" | "meta" => Some("LOGO"),
            _ => None,
        };
        if let Some(m) = modifier {
            if !mods.contains(&m) {
                mods.push(m);
            }
        } else if key.is_some() {
            return None;
        } else {
            key = Some(portal_key(part)?);
        }
    }
    let key = key?;
    let mut parts: Vec<String> = ["CTRL", "ALT", "SHIFT", "LOGO"]
        .into_iter()
        .filter(|m| mods.contains(m))
        .map(str::to_string)
        .collect();
    parts.push(key);
    Some(parts.join("+"))
}

/// A key in the XDG specification's (xkb keysym) names: letters lower case,
/// digits and F keys as they are, a few named keys.
fn portal_key(key: &str) -> Option<String> {
    let lower = key.to_ascii_lowercase();
    let named = match lower.as_str() {
        "space" => Some("space"),
        "printscreen" | "print" => Some("Print"),
        "enter" | "return" => Some("Return"),
        "tab" => Some("Tab"),
        _ => None,
    };
    if let Some(n) = named {
        return Some(n.to_string());
    }
    let single = |s: &str| {
        let mut chars = s.chars();
        matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_alphanumeric())
    };
    // "KeyA" / "Digit2", as Tauri also accepts them.
    let bare = lower
        .strip_prefix("key")
        .filter(|rest| single(rest))
        .or_else(|| lower.strip_prefix("digit").filter(|rest| single(rest)))
        .unwrap_or(&lower);
    if single(bare) {
        return Some(bare.to_string());
    }
    let f_key = bare.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=24).contains(n));
    f_key.map(|n| format!("F{n}"))
}

/// Bind the capture shortcut with `accelerator` as its preferred trigger,
/// or release it (`None`). Returns at once; the desktop may show a dialog,
/// and what it answered shows in Settings ([`trigger`], [`problem`]).
///
/// # Errors
///
/// A shortcut the desktop keeps for itself, or one with no modifier, is
/// refused before anything is asked.
#[cfg(target_os = "linux")]
pub fn apply(app: &tauri::AppHandle, accelerator: Option<&str>) -> crate::error::Result<()> {
    if let Some(accelerator) = accelerator {
        super::shortcut::validate(accelerator)?;
    }
    if !lane_offers_portal() {
        set_status(PortalStatus::Missing);
        return Ok(());
    }
    let cmd = match accelerator {
        Some(a) => live::Cmd::Bind {
            accelerator: a.to_string(),
            app_id: app.config().identifier.clone(),
        },
        None => live::Cmd::Release,
    };
    live::send(app, cmd);
    Ok(())
}

/// Open the desktop's own dialog to change the shortcut (portal version 2).
///
/// # Errors
///
/// [`crate::error::AppError::Validation`] when the desktop cannot, or no
/// shortcut is bound.
#[cfg(target_os = "linux")]
pub async fn configure(app: &tauri::AppHandle) -> crate::error::Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    live::send(app, live::Cmd::Configure(tx));
    rx.await
        .unwrap_or_else(|_| Err(BIND_FAILED.to_string()))
        .map_err(crate::error::AppError::Validation)
}

/// Whether this session and lane may use the portal.
#[cfg(target_os = "linux")]
fn lane_offers_portal() -> bool {
    use super::rollout::{Feature, Platform, allows, current_platform};
    current_platform() == Platform::LinuxWayland && allows(Feature::ShortcutPortal)
}

/// Ask once, at launch, whether the portal is here, so Settings and the
/// capture menus know which route to show before anything is bound.
#[cfg(target_os = "linux")]
pub fn warm() {
    if !lane_offers_portal() {
        set_status(PortalStatus::Missing);
        return;
    }
    tauri::async_runtime::spawn(async {
        let status = match ashpd::desktop::global_shortcuts::GlobalShortcuts::new().await {
            Ok(proxy) => PortalStatus::Available {
                configurable: proxy.version() >= 2,
            },
            Err(e) => {
                tracing::info!(error = %e, "no GlobalShortcuts portal; the capture shortcut goes through the desktop's settings");
                PortalStatus::Missing
            }
        };
        // A bind that already ran knows better.
        let mut k = known();
        if k.status == PortalStatus::Unknown {
            k.status = status;
        }
    });
}

#[cfg(target_os = "linux")]
mod live {
    use std::pin::Pin;
    use std::sync::OnceLock;

    use ashpd::desktop::global_shortcuts::{
        Activated, BindShortcutsOptions, ConfigureShortcutsOptions, GlobalShortcuts, NewShortcut, ShortcutsChanged,
    };
    use ashpd::desktop::{CreateSessionOptions, ResponseError, Session};
    use futures_util::{Stream, StreamExt};
    use tokio::sync::{mpsc, oneshot};

    use super::{BIND_DECLINED, BIND_FAILED, PortalStatus, SHORTCUT_DESCRIPTION, SHORTCUT_ID, portal_trigger, set_bound, set_status};

    pub enum Cmd {
        Bind { accelerator: String, app_id: String },
        Release,
        Configure(oneshot::Sender<Result<(), String>>),
    }

    static TX: OnceLock<mpsc::UnboundedSender<Cmd>> = OnceLock::new();

    /// Hand `cmd` to the one task that owns the portal session, starting it
    /// on first use.
    pub fn send(app: &tauri::AppHandle, cmd: Cmd) {
        let tx = TX.get_or_init(|| {
            let (tx, rx) = mpsc::unbounded_channel();
            tauri::async_runtime::spawn(run(app.clone(), rx));
            tx
        });
        let _ = tx.send(cmd);
    }

    type Signals<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

    /// A bound shortcut: the connection's proxy, the session and its
    /// signals.
    struct Bound {
        proxy: GlobalShortcuts,
        session: Session<GlobalShortcuts>,
        /// The session's object path, which signals name their session by
        /// (ashpd keeps the path itself private; it serializes as it).
        session_path: String,
        activated: Signals<Activated>,
        changed: Signals<ShortcutsChanged>,
    }

    enum Event {
        Cmd(Option<Cmd>),
        Activated(Option<Activated>),
        Changed(Option<ShortcutsChanged>),
    }

    async fn run(app: tauri::AppHandle, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        let mut bound: Option<Bound> = None;
        loop {
            let event = {
                // Two signal streams of one `Bound`: borrowed one after the
                // other through a split of the option.
                let (activated, changed) = match bound.as_mut() {
                    Some(b) => (Some(&mut b.activated), Some(&mut b.changed)),
                    None => (None, None),
                };
                tokio::select! {
                    cmd = rx.recv() => Event::Cmd(cmd),
                    a = async { match activated { Some(s) => s.next().await, None => std::future::pending().await } } => Event::Activated(a),
                    c = async { match changed { Some(s) => s.next().await, None => std::future::pending().await } } => Event::Changed(c),
                }
            };
            match event {
                Event::Cmd(None) => break,
                Event::Cmd(Some(Cmd::Bind { accelerator, app_id })) => {
                    release(&mut bound).await;
                    match bind(&accelerator, &app_id).await {
                        Ok((b, trigger)) => {
                            set_bound(trigger, None);
                            bound = Some(b);
                        }
                        Err(e) => {
                            let answer = crate::capture::linux_portal::classify(&e);
                            tracing::warn!(error = %e, "the capture shortcut was not bound through the portal");
                            match answer {
                                crate::capture::linux_portal::PortalAnswer::Missing => {
                                    set_status(PortalStatus::Missing);
                                    set_bound(None, None);
                                }
                                crate::capture::linux_portal::PortalAnswer::Cancelled => set_bound(None, Some(BIND_DECLINED)),
                                _ => set_bound(None, Some(BIND_FAILED)),
                            }
                        }
                    }
                }
                Event::Cmd(Some(Cmd::Release)) => {
                    release(&mut bound).await;
                    set_bound(None, None);
                }
                Event::Cmd(Some(Cmd::Configure(reply))) => {
                    // Held by value across the call: a borrow of `Bound`
                    // (its signal streams are not `Sync`) cannot cross an await.
                    let result = match bound.take() {
                        Some(b) if b.proxy.version() >= 2 => {
                            let opened = b
                                .proxy
                                .configure_shortcuts(&b.session, None, ConfigureShortcutsOptions::default())
                                .await
                                .map_err(|e| {
                                    tracing::warn!(error = %e, "the desktop's shortcut dialog did not open");
                                    BIND_FAILED.to_string()
                                });
                            bound = Some(b);
                            opened
                        }
                        Some(b) => {
                            bound = Some(b);
                            Err("Your desktop changes this shortcut in its own keyboard settings.".to_string())
                        }
                        None => Err("Turn the shortcut on first.".to_string()),
                    };
                    let _ = reply.send(result);
                }
                Event::Activated(Some(a)) => {
                    let ours = bound.as_ref().is_some_and(|b| a.session_handle().as_str() == b.session_path.as_str());
                    if ours && a.shortcut_id() == SHORTCUT_ID {
                        crate::capture::commands::on_shortcut(&app);
                    }
                }
                Event::Changed(Some(c)) => {
                    let ours = bound.as_ref().is_some_and(|b| c.session_handle().as_str() == b.session_path.as_str());
                    if ours && let Some(s) = c.shortcuts().iter().find(|s| s.id() == SHORTCUT_ID) {
                        set_bound(Some(s.trigger_description().to_string()).filter(|t| !t.trim().is_empty()), None);
                    }
                }
                // The connection went away: the shortcut is gone with it.
                Event::Activated(None) | Event::Changed(None) => {
                    bound = None;
                    set_bound(None, Some(BIND_FAILED));
                }
            }
        }
        release(&mut bound).await;
    }

    async fn release(bound: &mut Option<Bound>) {
        if let Some(b) = bound.take() {
            let _ = b.session.close().await;
        }
    }

    /// A new connection, registered under the app's id where the portal
    /// keeps a host registry, a session, and the one shortcut bound. The
    /// desktop may show a dialog; this waits for it.
    async fn bind(accelerator: &str, app_id: &str) -> Result<(Bound, Option<String>), ashpd::Error> {
        let connection = ashpd::zbus::Connection::session().await?;
        // Best effort: older portals have no registry, and a host app works
        // without it (the desktop then names it by its process).
        if let Ok(id) = ashpd::AppID::try_from(app_id)
            && let Err(e) = ashpd::register_host_app_with_connection(connection.clone(), id).await
        {
            tracing::debug!(error = %e, "the portal's host app registry did not take the app id");
        }
        let proxy = GlobalShortcuts::with_connection(connection).await?;
        set_status(PortalStatus::Available {
            configurable: proxy.version() >= 2,
        });
        let session = proxy.create_session(CreateSessionOptions::default()).await?;
        let activated: Signals<Activated> = Box::pin(proxy.receive_activated().await?);
        let changed: Signals<ShortcutsChanged> = Box::pin(proxy.receive_shortcuts_changed().await?);
        let preferred = portal_trigger(accelerator);
        let shortcut = NewShortcut::new(SHORTCUT_ID, SHORTCUT_DESCRIPTION).preferred_trigger(preferred.as_deref());
        let response = proxy
            .bind_shortcuts(&session, &[shortcut], None, BindShortcutsOptions::default())
            .await?
            .response();
        let response = match response {
            Ok(r) => r,
            Err(e) => {
                let _ = session.close().await;
                return Err(e);
            }
        };
        let trigger = response
            .shortcuts()
            .iter()
            .find(|s| s.id() == SHORTCUT_ID)
            .map(|s| s.trigger_description().to_string())
            .filter(|t| !t.trim().is_empty());
        // A bind the desktop answered without our shortcut: the user left it
        // unassigned in the dialog.
        if response.shortcuts().iter().all(|s| s.id() != SHORTCUT_ID) {
            let _ = session.close().await;
            return Err(ashpd::Error::Response(ResponseError::Cancelled));
        }
        let session_path = serde_json::to_value(&session)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        Ok((
            Bound {
                proxy,
                session,
                session_path,
                activated,
                changed,
            },
            trigger,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The saved accelerator becomes the portal's preferred trigger in the
    /// XDG names, modifiers in one order whatever order they were saved in.
    #[test]
    fn an_accelerator_becomes_the_portals_trigger() {
        assert_eq!(portal_trigger("CommandOrControl+Shift+2").as_deref(), Some("CTRL+SHIFT+2"));
        assert_eq!(portal_trigger("Shift+Control+C").as_deref(), Some("CTRL+SHIFT+c"));
        assert_eq!(portal_trigger("Alt+Super+KeyR").as_deref(), Some("ALT+LOGO+r"));
        assert_eq!(portal_trigger("Control+Alt+F12").as_deref(), Some("CTRL+ALT+F12"));
        assert_eq!(portal_trigger("Control+Digit5").as_deref(), Some("CTRL+5"));
        assert_eq!(portal_trigger("Control+Shift+Space").as_deref(), Some("CTRL+SHIFT+space"));
        assert_eq!(portal_trigger("Super+PrintScreen").as_deref(), Some("LOGO+Print"));
    }

    /// Anything not worth guessing leaves the choice to the desktop: no
    /// key, two keys, or a key the specification names differently.
    #[test]
    fn an_odd_accelerator_leaves_the_trigger_to_the_desktop() {
        assert_eq!(portal_trigger(""), None);
        assert_eq!(portal_trigger("Control+Shift"), None);
        assert_eq!(portal_trigger("Control+A+B"), None);
        assert_eq!(portal_trigger("Control+BracketLeft"), None);
        assert_eq!(portal_trigger("Control+F25"), None);
    }

    #[test]
    fn the_portal_copy_has_no_em_dashes() {
        for line in [SHORTCUT_DESCRIPTION, BIND_DECLINED, BIND_FAILED] {
            assert!(!line.contains('\u{2014}'), "{line}");
        }
    }

    #[test]
    fn only_an_answering_portal_is_available() {
        assert!(PortalStatus::Available { configurable: false }.available());
        assert!(!PortalStatus::Missing.available());
        assert!(!PortalStatus::Unknown.available());
    }
}

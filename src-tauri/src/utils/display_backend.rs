//! Which display connection the Linux app makes: a native Wayland client, or
//! an X11 client through XWayland.
//!
//! The recording pill and the camera bubble must stay above every other
//! window, or the bubble is missing from a screen recording. They ask for it
//! with `always_on_top`, which GTK turns into `_NET_WM_STATE_ABOVE` on X11
//! and into nothing at all on Wayland (`gdk_wayland_window_set_keep_above`
//! is an empty function in GTK 3, since no Wayland protocol Mutter offers a
//! client can say "keep me above"; Mutter has no layer-shell either). Mutter
//! does honour `_NET_WM_STATE_ABOVE` from an X11 client, XWayland included,
//! and it places an X11 client's windows where the client asks. So on a
//! GNOME Wayland session the app connects through XWayland, as Zoom does.
//!
//! What does NOT change: the session is still Wayland. `capture::rollout`
//! reads `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`, which this module never
//! touches, so screenshots, recording and the shortcut keep using the
//! portals (an XWayland client cannot read a Wayland window's pixels).
//!
//! The choice is made with `gdk_set_allowed_backends`, not by setting
//! `GDK_BACKEND`: that variable would be inherited by every program the app
//! starts (the file manager, the browser a link opens in), pushing them onto
//! XWayland too. `"x11,wayland"` tries XWayland first and falls back to
//! Wayland when it cannot connect, so the app still starts where XWayland
//! is missing or broken.
//!
//! **Off by default.** Under XWayland, GNOME with a scaled display drew the
//! Wayland area-recording overlay and its still at the wrong size (a quarter
//! of the screen), and Linux recording got worse on real machines, so the
//! app is a native Wayland client again, as it was before XWayland was
//! chosen. XWayland is used only when `HIPPIUS_XWAYLAND=1` is set (to try
//! the keep-above it gives the pill and bubble). The pill and the bubble
//! may then fall behind other windows on GNOME Wayland.
//!
//! Left alone even then: a `GDK_BACKEND` the user set (theirs to choose,
//! and GDK would refuse a backend outside the allowed list) and non-GNOME
//! desktops.

// Only Linux applies the decision; elsewhere it is compiled for its tests.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// Set to `1` (or `true`, `yes`, `on`) to connect through XWayland on GNOME
/// Wayland. Unset, the app is a native Wayland client.
pub const XWAYLAND_OPT_IN: &str = "HIPPIUS_XWAYLAND";

/// The backends GDK may use, in order, when XWayland is chosen.
pub const XWAYLAND_FIRST: &str = "x11,wayland";

/// The environment the decision reads, as the process got it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SessionEnv<'a> {
    pub xdg_session_type: Option<&'a str>,
    pub wayland_display: Option<&'a str>,
    /// `DISPLAY`: set by GNOME when XWayland is available.
    pub display: Option<&'a str>,
    /// `XDG_CURRENT_DESKTOP`, for example `ubuntu:GNOME`.
    pub current_desktop: Option<&'a str>,
    pub gdk_backend: Option<&'a str>,
    /// [`XWAYLAND_OPT_IN`].
    pub xwayland_opt_in: Option<&'a str>,
}

/// Which connection GTK makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// GTK's own choice (Wayland on a Wayland session, X11 on X11).
    Default,
    /// XWayland first, Wayland if XWayland cannot be reached.
    XWayland,
}

/// Why, for the log line a support bundle carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    NotLinux,
    NotWayland,
    UserSetGdkBackend,
    /// XWayland was not asked for (`HIPPIUS_XWAYLAND`): native Wayland.
    NotOptedIn,
    NoXWayland,
    NotGnome,
    /// GNOME's Wayland session ignores a Wayland client's keep-above.
    GnomeWaylandKeepAbove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub backend: Backend,
    pub why: Why,
}

const fn keep(why: Why) -> Choice {
    Choice {
        backend: Backend::Default,
        why,
    }
}

fn set(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn truthy(value: Option<&str>) -> bool {
    set(value).is_some_and(|v| ["1", "true", "yes", "on"].iter().any(|t| v.eq_ignore_ascii_case(t)))
}

/// Whether `XDG_CURRENT_DESKTOP` names GNOME. It is a colon-separated list
/// (`ubuntu:GNOME`, `pop:GNOME`, `Zorin:GNOME`), compared whole per entry.
#[must_use]
pub fn is_gnome(current_desktop: Option<&str>) -> bool {
    set(current_desktop).is_some_and(|d| d.split(':').any(|part| part.trim().eq_ignore_ascii_case("gnome")))
}

/// The connection to make, decided from the session alone. The order is
/// the order of the checks: a user's own `GDK_BACKEND` wins over
/// everything, and nothing changes unless XWayland was asked for.
#[must_use]
pub fn choose(env: &SessionEnv<'_>) -> Choice {
    if set(env.gdk_backend).is_some() {
        return keep(Why::UserSetGdkBackend);
    }
    if !truthy(env.xwayland_opt_in) {
        return keep(Why::NotOptedIn);
    }
    // The same test the capture surfaces use, so "Wayland" means one thing.
    if crate::capture::rollout::linux_platform(env.xdg_session_type, env.wayland_display) != crate::capture::rollout::Platform::LinuxWayland {
        return keep(Why::NotWayland);
    }
    if set(env.display).is_none() {
        return keep(Why::NoXWayland);
    }
    if !is_gnome(env.current_desktop) {
        return keep(Why::NotGnome);
    }
    Choice {
        backend: Backend::XWayland,
        why: Why::GnomeWaylandKeepAbove,
    }
}

/// Decide and tell GDK. Must run before GTK starts (before the Tauri
/// builder), like `app_id::apply`. Sets no environment variable.
#[cfg(target_os = "linux")]
#[must_use]
pub fn apply() -> Choice {
    let var = |name: &str| std::env::var(name).ok();
    let (session, wayland, display, desktop, gdk, opt_in) = (
        var("XDG_SESSION_TYPE"),
        var("WAYLAND_DISPLAY"),
        var("DISPLAY"),
        var("XDG_CURRENT_DESKTOP"),
        var("GDK_BACKEND"),
        var(XWAYLAND_OPT_IN),
    );
    let choice = choose(&SessionEnv {
        xdg_session_type: session.as_deref(),
        wayland_display: wayland.as_deref(),
        display: display.as_deref(),
        current_desktop: desktop.as_deref(),
        gdk_backend: gdk.as_deref(),
        xwayland_opt_in: opt_in.as_deref(),
    });
    if choice.backend == Backend::XWayland {
        gtk::gdk::set_allowed_backends(XWAYLAND_FIRST);
    }
    choice
}

#[cfg(not(target_os = "linux"))]
#[must_use]
pub const fn apply() -> Choice {
    keep(Why::NotLinux)
}

/// The GDK display GTK actually opened (`GdkX11Display` or
/// `GdkWaylandDisplay`), for the log: XWayland can fail and fall back.
#[cfg(target_os = "linux")]
#[must_use]
pub fn active_display() -> Option<String> {
    use gtk::glib::prelude::ObjectExt;
    gtk::gdk::Display::default().map(|d| d.type_().name().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GNOME_WAYLAND: SessionEnv<'static> = SessionEnv {
        xdg_session_type: Some("wayland"),
        wayland_display: Some("wayland-0"),
        display: Some(":0"),
        current_desktop: Some("ubuntu:GNOME"),
        gdk_backend: None,
        xwayland_opt_in: Some("1"),
    };

    /// Without the opt-in, GNOME on Wayland stays a native Wayland client.
    #[test]
    fn gnome_on_wayland_stays_native_unless_xwayland_is_asked_for() {
        for off in [None, Some("0"), Some("false"), Some(""), Some("no")] {
            let env = SessionEnv {
                xwayland_opt_in: off,
                ..GNOME_WAYLAND
            };
            assert_eq!(choose(&env), keep(Why::NotOptedIn), "{off:?}");
        }
    }

    /// With the opt-in, Ubuntu's GNOME on Wayland connects through XWayland,
    /// so the pill and bubble can stay on top.
    #[test]
    fn gnome_on_wayland_goes_through_xwayland_when_asked() {
        assert_eq!(
            choose(&GNOME_WAYLAND),
            Choice {
                backend: Backend::XWayland,
                why: Why::GnomeWaylandKeepAbove
            }
        );
        let only_display = SessionEnv {
            xdg_session_type: None,
            ..GNOME_WAYLAND
        };
        assert_eq!(choose(&only_display).backend, Backend::XWayland, "WAYLAND_DISPLAY alone is Wayland");
    }

    /// A user's own GDK_BACKEND, an X11 session, a session
    /// without XWayland and other desktops are left as GTK would choose.
    #[test]
    fn everything_else_keeps_gtks_own_choice() {
        let cases = [
            (
                SessionEnv {
                    gdk_backend: Some("wayland"),
                    ..GNOME_WAYLAND
                },
                Why::UserSetGdkBackend,
            ),
            (
                SessionEnv {
                    gdk_backend: Some("x11"),
                    ..GNOME_WAYLAND
                },
                Why::UserSetGdkBackend,
            ),
            (
                SessionEnv {
                    xdg_session_type: Some("x11"),
                    wayland_display: None,
                    ..GNOME_WAYLAND
                },
                Why::NotWayland,
            ),
            (
                SessionEnv {
                    display: None,
                    ..GNOME_WAYLAND
                },
                Why::NoXWayland,
            ),
            (
                SessionEnv {
                    display: Some("  "),
                    ..GNOME_WAYLAND
                },
                Why::NoXWayland,
            ),
            (
                SessionEnv {
                    current_desktop: Some("KDE"),
                    ..GNOME_WAYLAND
                },
                Why::NotGnome,
            ),
            (
                SessionEnv {
                    current_desktop: None,
                    ..GNOME_WAYLAND
                },
                Why::NotGnome,
            ),
        ];
        for (env, why) in cases {
            assert_eq!(choose(&env), keep(why), "{env:?}");
        }
        for on in ["1", " TRUE ", "yes", "on"] {
            let env = SessionEnv {
                xwayland_opt_in: Some(on),
                ..GNOME_WAYLAND
            };
            assert_eq!(choose(&env).backend, Backend::XWayland, "{on:?} asks for XWayland");
        }
        assert_eq!(
            choose(&SessionEnv {
                gdk_backend: Some(""),
                ..GNOME_WAYLAND
            })
            .backend,
            Backend::XWayland,
            "an empty GDK_BACKEND is unset"
        );
    }

    /// GNOME is matched as a whole entry of the list, in any case, and
    /// nothing that only contains the word.
    #[test]
    fn gnome_is_one_entry_of_the_desktop_list() {
        for d in ["GNOME", "ubuntu:GNOME", "pop:GNOME", "Zorin:GNOME", "gnome"] {
            assert!(is_gnome(Some(d)), "{d}");
        }
        for d in ["KDE", "GNOME-Flashback-ish", "Unity", "X-Cinnamon", "sway", ""] {
            assert!(!is_gnome(Some(d)), "{d}");
        }
        assert!(!is_gnome(None));
    }

    /// XWayland first, and Wayland after it, so a session where XWayland
    /// cannot start still opens the app (as a Wayland client).
    #[test]
    fn xwayland_falls_back_to_wayland() {
        assert_eq!(XWAYLAND_FIRST.split(',').collect::<Vec<_>>(), ["x11", "wayland"]);
    }

    /// The decision is pure: off Linux, `apply` sets nothing.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn off_linux_nothing_is_chosen() {
        assert_eq!(apply(), keep(Why::NotLinux));
    }
}

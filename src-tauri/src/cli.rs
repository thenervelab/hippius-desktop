//! CLI-only invocations that must not boot the Tauri UI.
//!
//! `--finder-share` lives in `finder_bridge::cli` because it talks to the
//! bridge socket. `--version` / `-V` is a print-and-exit so it cannot grow a
//! dependency on tracing, dotenv, or the builder.

use std::io::{self, Write};

/// True when argv asks for the version string and must not start the desktop.
pub fn argv_requests_version<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| {
        let a = a.as_ref();
        a == "--version" || a == "-V"
    })
}

/// Write `CARGO_PKG_VERSION` plus a newline and flush.
///
/// Uses `writeln!` rather than `println!` — the crate denies `print_stdout`.
/// Callers must `return` from `main` after this, not `process::exit`: exit
/// skips `Stdout`'s destructor, and a piped `--version` (`| cat`, `$(...)`)
/// is block-buffered so the line would die with the process.
pub fn write_version(out: &mut impl Write) -> io::Result<()> {
    writeln!(out, "{}", env!("CARGO_PKG_VERSION"))?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::{argv_requests_version, write_version};

    #[test]
    fn long_flag_is_a_version_request() {
        assert!(argv_requests_version(["--version"]));
    }

    #[test]
    fn short_flag_is_a_version_request() {
        assert!(argv_requests_version(["-V"]));
    }

    #[test]
    fn version_among_other_args_still_counts() {
        assert!(argv_requests_version(["foo", "--version", "bar"]));
    }

    #[test]
    fn ordinary_args_are_not_a_version_request() {
        assert!(!argv_requests_version(["--finder-share", "/tmp/x"]));
        assert!(!argv_requests_version(["--help"]));
        assert!(!argv_requests_version(["-v"]));
        assert!(!argv_requests_version(["--version-foo"]));
        assert!(!argv_requests_version(Vec::<&str>::new()));
    }

    #[test]
    fn write_version_emits_the_package_version_and_a_newline() {
        let mut buf = Vec::new();
        write_version(&mut buf).expect("write to vec");
        assert_eq!(buf, format!("{}\n", env!("CARGO_PKG_VERSION")).into_bytes());
    }
}

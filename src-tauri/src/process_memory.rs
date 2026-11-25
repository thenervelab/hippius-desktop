//! How much memory the app and its web views use, for one line in the log.
//!
//! A copy left open for days can grow without anything else in the log
//! saying so: on Windows the web views live in their own `msedgewebview2.exe`
//! processes under ours, and their committed memory (private bytes) is where
//! the growth shows, while their working set stays small because Windows
//! pages it out. The watchdog (`runtime_watchdog.rs`) samples this from a
//! plain OS thread, so the line keeps coming even when the async runtime is
//! stuck.
//!
//! Per platform:
//! - Windows: our process and every `msedgewebview2.exe` in the process tree
//!   under it (private bytes and working set).
//! - Linux: our process and every `WebKit*` process under it (anonymous
//!   resident memory plus swap as "private", resident as "working set").
//! - macOS: our process only (footprint and resident). WebKit's processes
//!   are started by launchd, not by us, so they are not cheap to find.

/// Memory of one process, or the sum over several.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    /// Memory only this process holds: committed private bytes on Windows,
    /// the physical footprint on macOS, anonymous resident plus swap on Linux.
    pub private_bytes: u64,
    /// What is resident in RAM right now.
    pub working_set_bytes: u64,
}

impl std::ops::AddAssign for Usage {
    fn add_assign(&mut self, other: Self) {
        self.private_bytes = self.private_bytes.saturating_add(other.private_bytes);
        self.working_set_bytes = self.working_set_bytes.saturating_add(other.working_set_bytes);
    }
}

/// One reading: the app's own process and, where they can be found, its web
/// view processes summed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sample {
    pub app: Option<Usage>,
    /// The web view processes summed, and how many there were.
    pub webviews: Option<(Usage, usize)>,
}

/// One process in a process listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

/// Every process under `root` in `entries`, children and their children, not
/// `root` itself. A process whose parent id loops back is visited once.
#[must_use]
pub fn descendants(root: u32, entries: &[ProcEntry]) -> Vec<&ProcEntry> {
    let mut found: Vec<&ProcEntry> = Vec::new();
    let mut seen = std::collections::HashSet::from([root]);
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for entry in entries.iter().filter(|e| e.parent == parent && e.pid != parent) {
            if seen.insert(entry.pid) {
                frontier.push(entry.pid);
                found.push(entry);
            }
        }
    }
    found
}

/// Whether a process by this name is one of the web engine's: WebView2 on
/// Windows, WebKitGTK on Linux (whose names the kernel cuts at 15 bytes).
#[must_use]
pub fn is_webview_process(name: &str) -> bool {
    name.eq_ignore_ascii_case("msedgewebview2.exe") || name.starts_with("WebKit")
}

/// Bytes as the log shows them: whole MB below 10 GB, one decimal GB above.
#[must_use]
pub fn format_bytes(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    const GB: u64 = 1024 * MB;
    if bytes >= 10 * GB {
        // Precision loss is irrelevant at log resolution.
        #[allow(clippy::cast_precision_loss)]
        let gb = bytes as f64 / GB as f64;
        format!("{gb:.1} GB")
    } else {
        format!("{} MB", bytes / MB)
    }
}

/// The one log line for a sample.
#[must_use]
pub fn summary_line(sample: &Sample) -> String {
    let app = sample.app.map_or_else(
        || "app unknown".to_string(),
        |u| {
            format!(
                "app private {} (working set {})",
                format_bytes(u.private_bytes),
                format_bytes(u.working_set_bytes)
            )
        },
    );
    let webviews = sample.webviews.map_or_else(
        || "web views not measured".to_string(),
        |(u, count)| {
            format!(
                "web views private {} (working set {}) in {count} processes",
                format_bytes(u.private_bytes),
                format_bytes(u.working_set_bytes)
            )
        },
    );
    format!("memory: {app}; {webviews}")
}

/// Sum the web view processes under `root` with `usage_of` for each.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn webviews_under(root: u32, entries: &[ProcEntry], usage_of: impl Fn(u32) -> Option<Usage>) -> (Usage, usize) {
    let mut total = Usage::default();
    let mut count = 0;
    for entry in descendants(root, entries).into_iter().filter(|e| is_webview_process(&e.name)) {
        if let Some(usage) = usage_of(entry.pid) {
            total += usage;
            count += 1;
        }
    }
    (total, count)
}

/// Read the app's memory now. Best effort: anything unreadable is `None`.
#[must_use]
pub fn sample() -> Sample {
    imp::sample()
}

#[cfg(windows)]
mod imp {
    use super::{ProcEntry, Sample, Usage, webviews_under};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

    pub fn sample() -> Sample {
        let me = std::process::id();
        let entries = processes();
        Sample {
            app: usage(me),
            webviews: (!entries.is_empty()).then(|| webviews_under(me, &entries, usage)),
        }
    }

    /// Every process on the system, from one Toolhelp snapshot.
    fn processes() -> Vec<ProcEntry> {
        let mut out = Vec::new();
        // SAFETY: the snapshot handle is checked by the wrapper and closed
        // below; `entry` is a properly sized PROCESSENTRY32W.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap_or(0),
                ..Default::default()
            };
            let mut more = Process32FirstW(snapshot, &raw mut entry).is_ok();
            while more {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                out.push(ProcEntry {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                });
                more = Process32NextW(snapshot, &raw mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        out
    }

    /// Private bytes and working set of one process.
    pub fn usage(pid: u32) -> Option<Usage> {
        // SAFETY: the handle is checked by the wrapper and closed before
        // returning; `counters` is a properly sized PROCESS_MEMORY_COUNTERS_EX,
        // which starts with the PROCESS_MEMORY_COUNTERS layout.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
            let mut counters = PROCESS_MEMORY_COUNTERS_EX {
                cb: u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>()).unwrap_or(0),
                ..Default::default()
            };
            let read = GetProcessMemoryInfo(handle, (&raw mut counters).cast::<PROCESS_MEMORY_COUNTERS>(), counters.cb);
            let _ = CloseHandle(handle);
            read.ok()?;
            Some(Usage {
                private_bytes: counters.PrivateUsage as u64,
                working_set_bytes: counters.WorkingSetSize as u64,
            })
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{ProcEntry, Sample, Usage, webviews_under};

    pub fn sample() -> Sample {
        let me = std::process::id();
        let entries = processes();
        Sample {
            app: usage(me),
            webviews: Some(webviews_under(me, &entries, usage)),
        }
    }

    fn status(pid: u32) -> Option<String> {
        std::fs::read_to_string(format!("/proc/{pid}/status")).ok()
    }

    fn processes() -> Vec<ProcEntry> {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| {
                let text = status(pid)?;
                let (name, parent) = super::parse_linux_status_identity(&text)?;
                Some(ProcEntry { pid, parent, name })
            })
            .collect()
    }

    fn usage(pid: u32) -> Option<Usage> {
        super::parse_linux_status_usage(&status(pid)?)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Sample, Usage};

    pub fn sample() -> Sample {
        Sample {
            app: usage(),
            webviews: None,
        }
    }

    fn usage() -> Option<Usage> {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        let pid = i32::try_from(std::process::id()).ok()?;
        // SAFETY: `info` is a properly sized rusage_info_v2 for the
        // RUSAGE_INFO_V2 flavor; it is read only when the call succeeds.
        let rc = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) };
        if rc != 0 {
            return None;
        }
        // SAFETY: the call succeeded, so the struct is filled in.
        let info = unsafe { info.assume_init() };
        Some(Usage {
            private_bytes: info.ri_phys_footprint,
            working_set_bytes: info.ri_resident_size,
        })
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod imp {
    pub fn sample() -> super::Sample {
        super::Sample::default()
    }
}

/// `Name:` and `PPid:` from a Linux `/proc/<pid>/status`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_linux_status_identity(text: &str) -> Option<(String, u32)> {
    let mut name = None;
    let mut parent = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Name:") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("PPid:") {
            parent = v.trim().parse().ok();
        }
    }
    Some((name?, parent?))
}

/// Memory from a Linux `/proc/<pid>/status`: `RssAnon` + `VmSwap` as private,
/// `VmRSS` as working set. A kernel thread has none of these lines.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_linux_status_usage(text: &str) -> Option<Usage> {
    let kb = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
    };
    let rss = kb("VmRSS:")?;
    let private = kb("RssAnon:").unwrap_or(rss).saturating_add(kb("VmSwap:").unwrap_or(0));
    Some(Usage {
        private_bytes: private * 1024,
        working_set_bytes: rss * 1024,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, parent: u32, name: &str) -> ProcEntry {
        ProcEntry {
            pid,
            parent,
            name: name.to_string(),
        }
    }

    #[test]
    fn descendants_walks_the_whole_tree_under_the_root_only() {
        // Hippius.exe (10) -> msedgewebview2 browser (20) -> renderer (21),
        // utility (22); an unrelated Edge (30) under explorer (1).
        let entries = vec![
            entry(1, 0, "explorer.exe"),
            entry(10, 1, "Hippius.exe"),
            entry(20, 10, "msedgewebview2.exe"),
            entry(21, 20, "msedgewebview2.exe"),
            entry(22, 20, "msedgewebview2.exe"),
            entry(23, 10, "Hippius.exe"),
            entry(30, 1, "msedgewebview2.exe"),
        ];
        let mut pids: Vec<u32> = descendants(10, &entries).into_iter().map(|e| e.pid).collect();
        pids.sort_unstable();
        assert_eq!(pids, vec![20, 21, 22, 23]);
    }

    #[test]
    fn descendants_survives_a_parent_loop() {
        // A reused pid can make two entries each other's parent.
        let entries = vec![entry(10, 1, "Hippius.exe"), entry(20, 10, "a"), entry(10, 20, "b")];
        let pids: Vec<u32> = descendants(10, &entries).into_iter().map(|e| e.pid).collect();
        assert_eq!(pids, vec![20]);
    }

    #[test]
    fn webview_processes_are_recognised_on_windows_and_linux_only() {
        assert!(is_webview_process("msedgewebview2.exe"));
        assert!(is_webview_process("MSEdgeWebView2.EXE"));
        assert!(is_webview_process("WebKitWebProces"));
        assert!(is_webview_process("WebKitNetworkPr"));
        assert!(!is_webview_process("Hippius.exe"));
        assert!(!is_webview_process("hippius-ffmpeg"));
    }

    #[test]
    fn webviews_are_summed_and_counted_but_other_children_are_not() {
        let entries = vec![
            entry(10, 1, "Hippius.exe"),
            entry(20, 10, "msedgewebview2.exe"),
            entry(21, 20, "msedgewebview2.exe"),
            entry(23, 10, "Hippius.exe"),
            entry(24, 21, "msedgewebview2.exe"),
        ];
        let usage_of = |pid: u32| {
            // 24 exited between the listing and the read.
            (pid != 24).then_some(Usage {
                private_bytes: u64::from(pid) * 1000,
                working_set_bytes: 1,
            })
        };
        let (total, count) = webviews_under(10, &entries, usage_of);
        assert_eq!(count, 2);
        assert_eq!(total.private_bytes, 41_000);
        assert_eq!(total.working_set_bytes, 2);
    }

    #[test]
    fn the_log_line_is_one_line_with_both_halves() {
        let gb = 1024 * 1024 * 1024;
        let line = summary_line(&Sample {
            app: Some(Usage {
                private_bytes: 3 * gb,
                working_set_bytes: 120 * 1024 * 1024,
            }),
            webviews: Some((
                Usage {
                    private_bytes: 15 * gb,
                    working_set_bytes: 280 * 1024 * 1024,
                },
                4,
            )),
        });
        assert_eq!(
            line,
            "memory: app private 3072 MB (working set 120 MB); web views private 15.0 GB (working set 280 MB) in 4 processes"
        );
        assert!(!line.contains('\n'));
        assert_eq!(summary_line(&Sample::default()), "memory: app unknown; web views not measured");
    }

    #[test]
    fn linux_status_is_parsed_for_identity_and_memory() {
        let text = "Name:\tWebKitWebProces\nUmask:\t0022\nPPid:\t4242\nVmRSS:\t  204800 kB\nRssAnon:\t  150000 kB\nVmSwap:\t    1000 kB\n";
        assert_eq!(parse_linux_status_identity(text), Some(("WebKitWebProces".to_string(), 4242)));
        assert_eq!(
            parse_linux_status_usage(text),
            Some(Usage {
                private_bytes: 151_000 * 1024,
                working_set_bytes: 204_800 * 1024,
            })
        );
        // A kernel thread has no memory lines.
        assert_eq!(parse_linux_status_usage("Name:\tkworker/0:1\nPPid:\t2\n"), None);
    }

    /// The real reading on the machine running the tests: our own process
    /// uses memory. On Windows this exercises the Toolhelp and process-status
    /// calls (CI runs it there); on Linux `/proc`; on macOS `proc_pid_rusage`.
    #[test]
    fn this_process_reads_a_nonzero_working_set() {
        let sample = sample();
        let app = sample.app.expect("our own process is readable");
        assert!(app.working_set_bytes > 0, "{sample:?}");
        assert!(app.private_bytes > 0, "{sample:?}");
        if cfg!(any(windows, target_os = "linux")) {
            assert!(sample.webviews.is_some(), "the tree is walked on Windows and Linux");
        }
    }
}

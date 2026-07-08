//! Hippius Windows Explorer shell extension — the `IExplorerCommand` COM in-proc
//! server that adds "Share with Hippius" to the right-click menu.
//!
//! # Architecture (mirrors the macOS `.appex`)
//! The extension does NO real work: on `Invoke` it reads the selected paths and
//! forwards each to the running app over the named pipe the app serves
//! (`finder_bridge`), writing one `SHARE:<path>` line ([`wire`]) per item. The
//! app opens its public/private chooser and mints — identical to the macOS and
//! Linux flows. All heavy work stays in the one long-running app process.
//!
//! # Packaging
//! Registered via a **sparse MSIX package** (`AppxManifest.xml`) that gives this
//! unpackaged app *package identity* (required for the Win11 primary context
//! menu) and points a packaged-COM registration at [`CLSID_HIPPIUS_SHARE`]. The
//! DLL is embedded in the app install dir; see `build-and-package.ps1` +
//! `../nsis-hooks.nsh`.
//!
//! # Status: SCAFFOLD
//! This compiles + iterates on a Windows host with the `windows` crate. The COM
//! interface method signatures are version-sensitive; spots that most commonly
//! need a per-version tweak are marked `// VERIFY(windows 0.58)`. The wire format
//! ([`wire`]) and pipe name are byte-pinned to the app side by KATs.

#![cfg(windows)]

mod wire;

use std::cell::RefCell;
use std::ffi::{c_void, OsString};
use std::io::Write;
use std::os::windows::ffi::OsStringExt;

use windows::core::{implement, Interface, Result, BOOL, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, E_NOTIMPL, E_POINTER, S_OK};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IObjectWithSelection, IObjectWithSelection_Impl, IShellItemArray, SIGDN_FILESYSPATH,
};

/// CLSID identifying the Share command. MUST equal the `Class Id` in
/// `AppxManifest.xml`. Generate a fresh GUID (`uuidgen`/`guidgen`) before
/// shipping and paste it in BOTH places.
pub const CLSID_HIPPIUS_SHARE: GUID = GUID::from_u128(0x0F1E2D3C_4B5A_6978_8796_A5B4C3D2E1F0);

/// The command Explorer instantiates per right-click. Holds the current
/// selection set by `IObjectWithSelection::SetSelection`.
#[implement(IExplorerCommand, IObjectWithSelection)]
struct ShareCommand {
    selection: RefCell<Option<IShellItemArray>>,
}

impl ShareCommand {
    fn new() -> Self {
        Self { selection: RefCell::new(None) }
    }
}

impl IObjectWithSelection_Impl for ShareCommand_Impl {
    fn SetSelection(&self, psia: windows::core::Ref<'_, IShellItemArray>) -> Result<()> {
        // VERIFY(windows 0.58): `Ref::ok()` yields `Result<&T>`; clone to own it.
        *self.selection.borrow_mut() = psia.ok().ok().cloned();
        Ok(())
    }

    fn GetSelection(&self, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        match self.selection.borrow().as_ref() {
            Some(sel) => unsafe { sel.query(&*riid, ppv).ok() },
            None => Err(E_POINTER.into()),
        }
    }
}

impl IExplorerCommand_Impl for ShareCommand_Impl {
    fn GetTitle(&self, _items: windows::core::Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        // The shell frees this with CoTaskMemFree; allocate accordingly.
        to_task_mem_pwstr("Share with Hippius")
    }

    fn GetIcon(&self, _items: windows::core::Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        // Point at the app's icon resource once packaging is wired; empty = none.
        Err(E_NOTIMPL.into())
    }

    fn GetToolTip(&self, _items: windows::core::Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(GUID::zeroed())
    }

    fn GetState(&self, _items: windows::core::Ref<'_, IShellItemArray>, _ok_to_be_slow: BOOL) -> Result<u32> {
        // Always enabled. Do NO slow/network work here — this runs on the shell
        // UI thread (Microsoft's IExplorerCommand guidance). ECS_ENABLED = 0.
        Ok(0)
    }

    fn Invoke(&self, items: windows::core::Ref<'_, IShellItemArray>, _bind_ctx: windows::core::Ref<'_, windows::Win32::System::Com::IBindCtx>) -> Result<()> {
        // Prefer the invoke-time selection; fall back to the one SetSelection stored.
        let array = items.ok().ok().cloned().or_else(|| self.selection.borrow().clone());
        let Some(array) = array else {
            return Ok(());
        };
        let paths = collect_paths(&array);
        // Do the pipe I/O OFF the shell thread so the context menu never blocks.
        std::thread::spawn(move || {
            forward_paths(&paths);
        });
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        // ECF_DEFAULT = 0.
        Ok(0)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(E_NOTIMPL.into())
    }
}

/// Read every selected item's filesystem path from the `IShellItemArray`.
fn collect_paths(array: &IShellItemArray) -> Vec<OsString> {
    let mut out = Vec::new();
    let count = unsafe { array.GetCount() }.unwrap_or(0);
    for i in 0..count {
        let Ok(item) = (unsafe { array.GetItemAt(i) }) else {
            continue;
        };
        // SIGDN_FILESYSPATH yields the on-disk path; non-filesystem items error
        // and are skipped (we can only share real files/folders).
        if let Ok(pwstr) = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) } {
            out.push(pwstr_to_osstring(pwstr));
            unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0 as *const c_void)) };
        }
    }
    out
}

/// Connect to the app's named pipe and write one `SHARE:<path>\n` per path.
/// Best-effort: if the app isn't running the connect fails and the click is
/// dropped. TODO(scaffold): launch the app (`ShellExecuteW` on the install-dir
/// exe) and retry, mirroring the Linux `--finder-share` launch-and-retry.
fn forward_paths(paths: &[OsString]) {
    use std::fs::OpenOptions;

    let name = wire::pipe_name_for_current_user();
    // A Windows named pipe client opens as a file handle.
    let Ok(mut pipe) = OpenOptions::new().read(true).write(true).open(&name) else {
        return;
    };
    for path in paths {
        let line = wire::share_line(path);
        if pipe.write_all(line.as_bytes()).is_err() || pipe.write_all(b"\n").is_err() {
            return;
        }
    }
    let _ = pipe.flush();
}

/// Copy `s` into a `CoTaskMemAlloc` buffer as a NUL-terminated wide string — the
/// ownership the shell expects for `GetTitle` (it frees with `CoTaskMemFree`).
fn to_task_mem_pwstr(s: &str) -> Result<PWSTR> {
    use windows::Win32::System::Com::CoTaskMemAlloc;

    let mut wide: Vec<u16> = s.encode_utf16().collect();
    wide.push(0);
    let bytes = std::mem::size_of_val(&wide[..]);
    let ptr = unsafe { CoTaskMemAlloc(bytes) } as *mut u16;
    if ptr.is_null() {
        return Err(E_POINTER.into());
    }
    unsafe { std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len()) };
    Ok(PWSTR(ptr))
}

/// Read a shell-owned wide string into an `OsString` (up to the NUL).
fn pwstr_to_osstring(pwstr: PWSTR) -> OsString {
    if pwstr.is_null() {
        return OsString::new();
    }
    let mut len = 0usize;
    // SAFETY: the shell guarantees a NUL-terminated buffer.
    while unsafe { *pwstr.0.add(len) } != 0 {
        len += 1;
    }
    let slice = unsafe { std::slice::from_raw_parts(pwstr.0, len) };
    OsString::from_wide(slice)
}

// ----- COM class factory + DLL exports -----------------------------------

/// Factory the shell uses to create [`ShareCommand`] instances.
#[implement(IClassFactory)]
struct ShareCommandFactory;

impl IClassFactory_Impl for ShareCommandFactory_Impl {
    fn CreateInstance(&self, outer: windows::core::Ref<'_, windows::core::IUnknown>, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        if outer.is_some() {
            return Err(windows::Win32::Foundation::CLASS_E_NOAGGREGATION.into());
        }
        let command: IExplorerCommand = ShareCommand::new().into();
        unsafe { command.query(&*riid, ppv).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        Ok(())
    }
}

/// COM entry point: hand out the class factory for our CLSID.
///
/// # Safety
/// Raw COM ABI: `rclsid`/`riid` are valid GUID pointers and `ppv` a valid outptr
/// per the COM contract the shell upholds.
#[no_mangle]
unsafe extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    if *rclsid != CLSID_HIPPIUS_SHARE {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = ShareCommandFactory.into();
    match factory.query(&*riid, ppv).ok() {
        Ok(()) => S_OK,
        Err(e) => e.code(),
    }
}

/// The DLL never keeps global lock state (per-instance only), so it may always
/// unload.
#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_OK
}

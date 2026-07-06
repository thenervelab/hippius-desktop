//! macOS security-scoped bookmark persistence.
//!
//! On macOS, the app sandbox requires bookmarks to retain access to
//! user-chosen directories across app restarts. This module stores
//! those bookmarks in SQLite. Every item here is macOS-only — the sole
//! caller (`sync::paths::set_sync_path_internal`) is itself macOS-gated,
//! so on other platforms this module compiles to nothing (no stubs needed).

// `SqlitePool` is referenced only by the macOS `store_bookmark`; gate the import
// so the non-macOS build — where this module compiles to nothing — has no unused
// import under `-D warnings`.
#[cfg(target_os = "macos")]
use sqlx::sqlite::SqlitePool;

#[cfg(target_os = "macos")]
use cocoa::base::id;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
// `debug`/`error` are used only inside the macOS-gated functions below, so the
// import must be gated too — otherwise the non-macOS build sees an unused import
// and fails under `-D warnings` (only the new Linux CI lane surfaces this).
#[cfg(target_os = "macos")]
use tracing::{debug, error};

// Every `unsafe` block below is scoped to a single Objective-C message send (or
// the one raw-pointer read at the end) with its own `// SAFETY:` note. All the
// safe logic — null checks, `CString` construction, error formatting, logging,
// the `.to_vec()` copy — lives outside the unsafe blocks so each unsafe region
// is minimal and individually auditable.
//
// Note on miri: this path cannot be exercised under `cargo miri` — every unsafe
// operation is a live-runtime ObjC `msg_send!` (foreign function call), which
// miri does not execute, and the only non-FFI unsafe op (`from_raw_parts`)
// consumes a pointer/length that come straight from `NSData`. There is no
// isolatable pure-Rust unsafe path to drive under miri.
#[cfg(target_os = "macos")]
pub fn create_security_scoped_bookmark(path: &str) -> Result<Vec<u8>, String> {
    debug!("Attempting to create security-scoped bookmark for: {}", path);

    let ns_string_class = class!(NSString);
    let ns_url_class = class!(NSURL);

    // Path → NUL-terminated C string (safe; rejects paths with interior NULs).
    let c_path = std::ffi::CString::new(path).map_err(|e| e.to_string())?;

    // SAFETY: `+[NSString stringWithUTF8String:]` reads a NUL-terminated C
    // string and returns an autoreleased NSString (or nil). `c_path` is a live,
    // valid NUL-terminated buffer for the duration of this call, and the
    // `(id, SEL, *const c_char) -> id` selector signature matches the message.
    let path_str: id = unsafe { msg_send![ns_string_class, stringWithUTF8String: c_path.as_ptr()] };

    // SAFETY: `+[NSURL fileURLWithPath:]` takes an NSString and returns an
    // autoreleased NSURL (or nil); `path_str` is the NSString produced above and
    // the `(id, SEL, id) -> id` signature matches.
    let url: id = unsafe { msg_send![ns_url_class, fileURLWithPath: path_str] };

    if url.is_null() {
        error!("Failed to create URL from path: {}", path);
        return Err("Failed to create URL from path".to_string());
    }

    debug!("Bookmark URL created successfully");

    // Out-param the ObjC call sets to an autoreleased NSError on failure.
    let mut error: id = std::ptr::null_mut();
    // SAFETY: `-[NSURL bookmarkDataWithOptions:includingResourceValuesForKeys:relativeToURL:error:]`
    // is sent to the non-null NSURL `url` (checked above). `0x800` is
    // NSURLBookmarkCreationWithSecurityScope; the two nil pointers are valid
    // "no value" arguments per the API; `&mut error` is a writable `*mut id`
    // the runtime sets (or leaves null). Argument types match the selector
    // signature; returns an autoreleased NSData (or nil).
    let bookmark_data: id = unsafe {
        msg_send![
            url,
            bookmarkDataWithOptions: 0x800  // NSURLBookmarkCreationWithSecurityScope
            includingResourceValuesForKeys: std::ptr::null::<id>()
            relativeToURL: std::ptr::null::<id>()
            error: &mut error
        ]
    };

    if bookmark_data.is_null() || !error.is_null() {
        if !error.is_null() {
            // SAFETY: `error` is a non-null NSError (checked); `localizedDescription`
            // returns an autoreleased NSString (or nil) and matches `(id, SEL) -> id`.
            let error_desc: id = unsafe { msg_send![error, localizedDescription] };
            // SAFETY: `error_desc` is an NSString (or nil); `-[NSString UTF8String]`
            // returns a pointer to a NUL-terminated UTF-8 buffer owned by that
            // (autoreleased) string, valid until the pool drains — i.e. for the
            // rest of this function. Matches `(id, SEL) -> *const c_char`.
            let error_cstr: *const i8 = unsafe { msg_send![error_desc, UTF8String] };
            if !error_cstr.is_null() {
                // SAFETY: `error_cstr` is non-null (checked) and, per `UTF8String`'s
                // contract, points to a NUL-terminated string valid for reads
                // through the terminator; we only borrow it to copy into an owned
                // String below.
                let error_str = unsafe { std::ffi::CStr::from_ptr(error_cstr) }.to_string_lossy().into_owned();
                error!("Failed to create bookmark: {}", error_str);
                return Err(format!("Failed to create security-scoped bookmark: {error_str}"));
            }
        }
        error!("Failed to create security-scoped bookmark (unknown error)");
        return Err("Failed to create security-scoped bookmark".to_string());
    }

    // SAFETY: `bookmark_data` is a non-null NSData (checked above); `length`
    // matches the `-[NSData length] -> usize` selector signature.
    let length: usize = unsafe { msg_send![bookmark_data, length] };
    // SAFETY: same non-null NSData; `bytes` matches `-[NSData bytes] -> *const u8`.
    let bytes: *const u8 = unsafe { msg_send![bookmark_data, bytes] };

    // `-[NSData bytes]` returns NULL for a zero-length NSData, and
    // `slice::from_raw_parts` requires a non-null pointer *even for len 0* — so
    // the empty case must not flow through `from_raw_parts`. A real
    // security-scoped bookmark is never empty, but we short-circuit defensively
    // rather than stamp a false "bytes is non-null" claim onto the unsafe block.
    let data = if length == 0 {
        Vec::new()
    } else {
        // SAFETY: `length > 0` here, so `bytes` is the non-null pointer NSData
        // gives for non-empty data: `length` contiguous initialized bytes owned
        // by the live `bookmark_data`. `u8` has alignment 1; the range lies in
        // one allocation well under isize::MAX; and we neither mutate nor retain
        // the borrowed slice past the `.to_vec()` copy ("not mutated for 'a").
        unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
    };

    debug!("Successfully created bookmark ({} bytes)", data.len());
    Ok(data)
}

/// Stores a security-scoped bookmark for a path in the database.
#[cfg(target_os = "macos")]
pub async fn store_bookmark(pool: &SqlitePool, path: &str, scope_type: &str) -> Result<(), String> {
    let bookmark_data = create_security_scoped_bookmark(path)?;

    sqlx::query(
        "INSERT OR REPLACE INTO security_scoped_bookmarks (path, bookmark_data, scope_type, last_accessed)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
    )
    .bind(path)
    .bind(&bookmark_data)
    .bind(scope_type)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to store bookmark: {e}"))?;

    debug!("Stored security-scoped bookmark for: {}", path);
    Ok(())
}

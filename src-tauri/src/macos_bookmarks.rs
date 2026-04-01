//! macOS security-scoped bookmark creation via Objective-C FFI.
//!
//! Security-scoped bookmarks allow the sandboxed app to retain access to
//! user-chosen directories across app restarts. The bookmark data is
//! persisted by [`crate::utils::bookmark_db`].

#[cfg(target_os = "macos")]
use cocoa::base::id;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
#[cfg(target_os = "macos")]
use tracing::{debug, error};

#[cfg(target_os = "macos")]
pub fn create_security_scoped_bookmark(path: &str) -> Result<Vec<u8>, String> {
    unsafe {
        debug!("Attempting to create security-scoped bookmark for: {}", path);

        let ns_string_class = class!(NSString);
        let ns_url_class = class!(NSURL);

        // Create NSString from path
        let c_path = std::ffi::CString::new(path).map_err(|e| e.to_string())?;
        let path_str: id = msg_send![ns_string_class, stringWithUTF8String: c_path.as_ptr()];

        // Create NSURL from path
        let url: id = msg_send![ns_url_class, fileURLWithPath: path_str];

        if url.is_null() {
            error!("Failed to create URL from path: {}", path);
            return Err("Failed to create URL from path".to_string());
        }

        debug!("Bookmark URL created successfully");

        // Create bookmark data with security scope
        let mut error: id = std::ptr::null_mut();
        let bookmark_data: id = msg_send![
            url,
            bookmarkDataWithOptions: 0x800  // NSURLBookmarkCreationWithSecurityScope
            includingResourceValuesForKeys: std::ptr::null::<id>()
            relativeToURL: std::ptr::null::<id>()
            error: &mut error
        ];

        if bookmark_data.is_null() || !error.is_null() {
            if !error.is_null() {
                let error_desc: id = msg_send![error, localizedDescription];
                let error_cstr: *const i8 = msg_send![error_desc, UTF8String];
                if !error_cstr.is_null() {
                    let error_str = std::ffi::CStr::from_ptr(error_cstr).to_string_lossy().into_owned();
                    error!("Failed to create bookmark: {}", error_str);
                    return Err(format!("Failed to create security-scoped bookmark: {error_str}"));
                }
            }
            error!("Failed to create security-scoped bookmark (unknown error)");
            return Err("Failed to create security-scoped bookmark".to_string());
        }

        // Convert NSData to Vec<u8>
        let length: usize = msg_send![bookmark_data, length];
        let bytes: *const u8 = msg_send![bookmark_data, bytes];
        let data = std::slice::from_raw_parts(bytes, length).to_vec();

        debug!("Successfully created bookmark ({} bytes)", data.len());
        Ok(data)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn create_security_scoped_bookmark(_path: &str) -> Result<Vec<u8>, String> {
    Ok(Vec::new())
}

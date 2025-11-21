

#[cfg(target_os = "macos")]
use cocoa::base::id;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[cfg(target_os = "macos")]
pub fn create_security_scoped_bookmark(path: &str) -> Result<Vec<u8>, String> {
    unsafe {
        let ns_string_class = class!(NSString);
        let ns_url_class = class!(NSURL);
        let ns_data_class = class!(NSData);
        
        // Create NSString from path
        let path_str: id = msg_send![ns_string_class, stringWithUTF8String: path.as_ptr()];
        
        // Create NSURL from path
        let url: id = msg_send![ns_url_class, fileURLWithPath: path_str];
        
        if url.is_null() {
            return Err("Failed to create URL from path".to_string());
        }
        
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
            return Err("Failed to create security-scoped bookmark".to_string());
        }
        
        // Convert NSData to Vec<u8>
        let length: usize = msg_send![bookmark_data, length];
        let bytes: *const u8 = msg_send![bookmark_data, bytes];
        let data = std::slice::from_raw_parts(bytes, length).to_vec();
        
        Ok(data)
    }
}

#[cfg(target_os = "macos")]
pub fn resolve_security_scoped_bookmark(bookmark_data: &[u8]) -> Result<(String, id), String> {
    unsafe {
        let ns_data_class = class!(NSData);
        let ns_url_class = class!(NSURL);
        
        // Create NSData from bookmark bytes
        let data: id = msg_send![
            ns_data_class,
            dataWithBytes: bookmark_data.as_ptr()
            length: bookmark_data.len()
        ];
        
        if data.is_null() {
            return Err("Failed to create NSData from bookmark".to_string());
        }
        
        // Resolve bookmark
        let mut is_stale: bool = false;
        let mut error: id = std::ptr::null_mut();
        let url: id = msg_send![
            ns_url_class,
            URLByResolvingBookmarkData: data
            options: 0x400  // NSURLBookmarkResolutionWithSecurityScope
            relativeToURL: std::ptr::null::<id>()
            bookmarkDataIsStale: &mut is_stale
            error: &mut error
        ];
        
        if url.is_null() || !error.is_null() {
            return Err("Failed to resolve security-scoped bookmark".to_string());
        }
        
        // Start accessing security-scoped resource
        let did_start: bool = msg_send![url, startAccessingSecurityScopedResource];
        if !did_start {
            return Err("Failed to start accessing security-scoped resource".to_string());
        }
        
        // Get path string
        let path_obj: id = msg_send![url, path];
        let path_cstr: *const i8 = msg_send![path_obj, UTF8String];
        let path = std::ffi::CStr::from_ptr(path_cstr)
            .to_string_lossy()
            .into_owned();
        
        Ok((path, url))
    }
}

#[cfg(target_os = "macos")]
pub fn stop_accessing_security_scoped_resource(url: id) {
    unsafe {
        let _: () = msg_send![url, stopAccessingSecurityScopedResource];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn create_security_scoped_bookmark(_path: &str) -> Result<Vec<u8>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_security_scoped_bookmark(_bookmark_data: &[u8]) -> Result<(String, ()), String> {
    Err("Not supported on this platform".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn stop_accessing_security_scoped_resource(_url: ()) {}

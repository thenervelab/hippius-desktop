//! Pure logic functions extracted from the API client.
//!
//! These functions contain no side effects, no global state, and no I/O.
//! They exist so that URL encoding, URL construction, and error formatting
//! can be unit-tested in isolation without needing a running Tauri app.

/// Minimal percent-encoding for query parameter values.
///
/// Encodes all characters except unreserved characters (RFC 3986):
/// `A-Z`, `a-z`, `0-9`, `-`, `_`, `.`, `~`.
/// Spaces are encoded as `%20` (not `+`).
pub fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                result.push(c);
            }
            ' ' => result.push_str("%20"),
            _ => {
                use std::fmt::Write;
                for b in c.to_string().as_bytes() {
                    let _ = write!(result, "%{b:02X}");
                }
            }
        }
    }
    result
}

/// Build a URL with query parameters appended.
///
/// Keys and values are percent-encoded. An empty `params` slice
/// produces a URL with no `?` suffix.
pub fn url_with_params(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{base}{path}");
    if !params.is_empty() {
        url.push('?');
        for (i, (key, value)) in params.iter().enumerate() {
            if i > 0 {
                url.push('&');
            }
            url.push_str(&urlencoding(key));
            url.push('=');
            url.push_str(&urlencoding(value));
        }
    }
    url
}

/// Structured error from API calls.
#[derive(Debug)]
pub enum ApiError {
    /// HTTP error with status code and body.
    Http { status: u16, body: String },
    /// Network or serialization error.
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http { status, body } => write!(f, "HTTP {status}: {body}"),
            ApiError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // URL encoding
    // -----------------------------------------------------------------------

    #[test]
    fn encode_unreserved_chars_unchanged() {
        assert_eq!(urlencoding("abc-XYZ_01.~"), "abc-XYZ_01.~");
    }

    #[test]
    fn encode_space_as_percent20() {
        assert_eq!(urlencoding("hello world"), "hello%20world");
    }

    #[test]
    fn encode_ampersand() {
        assert_eq!(urlencoding("foo&bar"), "foo%26bar");
    }

    #[test]
    fn encode_equals() {
        assert_eq!(urlencoding("a=b"), "a%3Db");
    }

    #[test]
    fn encode_slash() {
        assert_eq!(urlencoding("path/to/file"), "path%2Fto%2Ffile");
    }

    #[test]
    fn encode_empty_string() {
        assert_eq!(urlencoding(""), "");
    }

    #[test]
    fn encode_multibyte_utf8() {
        // Euro sign U+20AC is 3 bytes in UTF-8: E2 82 AC
        assert_eq!(urlencoding("\u{20AC}"), "%E2%82%AC");
    }

    #[test]
    fn encode_4byte_emoji() {
        // Grinning face U+1F600 is 4 bytes in UTF-8: F0 9F 98 80
        assert_eq!(urlencoding("\u{1F600}"), "%F0%9F%98%80");
    }

    #[test]
    fn encode_ss58_address_unchanged() {
        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        assert_eq!(urlencoding(addr), addr);
    }

    // -----------------------------------------------------------------------
    // URL construction
    // -----------------------------------------------------------------------

    #[test]
    fn url_no_params() {
        let url = url_with_params("https://api.example.com", "/v1/items", &[]);
        assert_eq!(url, "https://api.example.com/v1/items");
    }

    #[test]
    fn url_single_param() {
        let url = url_with_params("https://api.example.com", "/search", &[("q", "hello world")]);
        assert_eq!(url, "https://api.example.com/search?q=hello%20world");
    }

    #[test]
    fn url_multiple_params() {
        let url = url_with_params("https://api.example.com", "/search", &[("q", "rust"), ("page", "2")]);
        assert_eq!(url, "https://api.example.com/search?q=rust&page=2");
    }

    #[test]
    fn url_params_with_special_chars() {
        let url = url_with_params("https://api.example.com", "/data", &[("filter", "a&b=c")]);
        assert_eq!(url, "https://api.example.com/data?filter=a%26b%3Dc");
    }

    // -----------------------------------------------------------------------
    // ApiError formatting
    // -----------------------------------------------------------------------

    #[test]
    fn api_error_http_display() {
        let err = ApiError::Http {
            status: 401,
            body: "Unauthorized".into(),
        };
        assert_eq!(format!("{err}"), "HTTP 401: Unauthorized");
    }

    #[test]
    fn api_error_other_display() {
        let err = ApiError::Other("connection refused".into());
        assert_eq!(format!("{err}"), "connection refused");
    }

    #[test]
    fn api_error_to_string_conversion() {
        let err = ApiError::Http {
            status: 500,
            body: "Internal Server Error".into(),
        };
        let s: String = err.into();
        assert_eq!(s, "HTTP 500: Internal Server Error");
    }
}

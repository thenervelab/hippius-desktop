//! Entry options shared by every zip archive the app writes.
//!
//! zip 9 stamps entries as made by `System::Dos` when built for Windows, which
//! changes the "version made by" byte, adds DOS attribute bits, and makes
//! `unix_mode()` read back 0o100664 / 0o040775 instead of 0o100644 / 0o040755.
//! zip 4 always wrote `System::Unix`. Every writer starts from [`options`] so
//! the wallet backup, recovery-phrase backup, folder export and log bundle are
//! byte-for-byte the same shape on all three platforms.

use zip::System;
use zip::write::SimpleFileOptions;

/// Returns default entry options stamped as made by Unix on every platform.
pub fn options() -> SimpleFileOptions {
    SimpleFileOptions::default().system(System::Unix)
}

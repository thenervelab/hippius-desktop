// What the sync engine (hcfs-client, pinned in src-tauri/Cargo.toml) does
// with a file deleted in Finder or released from the large-delete prompt.
//
// The pinned engine sends those deletes to `/delete_files`, which deletes
// for good: it has no Trash calls yet. Every surface that would tell the
// user an engine delete "goes to Trash" reads this and keeps today's words
// until a pin bump brings an engine that trashes (`/v1/trash/.../files`).
// Flip it in the same change as that bump.
export const ENGINE_SENDS_DELETES_TO_TRASH = false;

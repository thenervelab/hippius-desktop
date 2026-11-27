# Starred, Devices and file details on the desktop

Parity with the mobile app (Release 1.5.0) and the web Drive, against the
live hcfs-server routes, without bumping the hcfs pin: the desktop calls
`/favorites`, `/v1/devices` and the `/search_files` `file_id` lookup with its
own HTTP code and wire types.

- Starred: `src-tauri/src/sync/fileops/favorites` (star, batch, list, scopes);
  the webview in `app/lib/starred`, `app/components/page-sections/starred`.
  The page is the Drive's own `DriveContent` (table and cards) over the
  starred rows. The Drive view takes two things only a list from many drives
  needs: `DriveRoute.folderHref` (a folder or drive opens on the Starred page
  itself, `/starred?openLabel=…`, which then hosts the Drive container for
  that drive with "Starred" as the first crumb, as Shared Drives does) and
  `FormattedUserFile.isDriveRoot` (a starred drive: it expands to its root,
  opens the drive, and offers Open and Star only, never selection, since its
  source is the sync root). Starred folders carry their full path in
  `actualFileName`, which every Drive path resolver keeps as it is.
- Devices: `src-tauri/src/devices` (registration loop, Settings › Devices,
  file details); the webview in
  `app/components/page-sections/settings/devices`.

## Not done: uploads do not name this computer

The server links an upload to a device when the manifest carries
`device_id` (`upload.md`, "Upload origin"), which moves the device's
`last_active_at` and lets the file details say "Uploaded from" for files
uploaded here. The sync engine builds its manifests inside the pinned
hcfs-client, which has no way to take a device id, so desktop uploads carry
none. That needs an hcfs-client change (an optional `device_id` on the
engine's upload config) and a pin bump; the registered id is already saved
per account in `device_registration` for when it lands. Until then this
computer shows in Settings › Devices with the activity of its registration.

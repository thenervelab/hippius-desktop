# Changelog

All notable changes to Hippius Desktop, written for everyone — not just engineers.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**How to add to it:** put your entry under `[Unreleased]` in the same pull request as
the change, in the category that fits (Added / Changed / Fixed / Security / Removed).
Write what the user gets, not how it works — "uploads are faster on slow connections",
not "parallel chunk uploads with per-chunk retry". One line each. On release, rename
`[Unreleased]` to the version and date, and open a fresh `[Unreleased]` above it.

---

## [Unreleased]

### Added

- **Support can diagnose problems faster from the logs you send.** Logs attached to
  a support ticket now say which app version and platform they came from, and if
  the app ever crashes, what went wrong is recorded instead of being lost.
- **Preview far more of your files without leaving Hippius.** Word documents open as
  real pages, PowerPoint decks as slides you can click through, spreadsheets and CSVs
  in a familiar spreadsheet grid with a formula bar and sheet tabs, and Markdown,
  text, JSON, HTML and SVG files all open in the same viewer as your photos and
  videos — with the same arrow-key navigation, thumbnails, download and delete.
  Files are previewed on your own machine; nothing is sent to an outside viewing
  service. Anything too big to open quickly still offers a download instead, and
  says so.
- **Try new features early with the beta channel.** Choose **Explore Beta** from
  the account menu to move onto builds that get new features first, before they
  are fully stabilized. Hippius downloads the build and restarts. You can go back
  to the stable version at any time from Settings.
- **Browse folders synced from your other devices without downloading them.**
  Click a folder under "Sync from Other Devices" to open it like any drive —
  navigate subfolders, see real sizes, preview and download individual files,
  and share files or folders via link, all straight from the server. Files
  load a page at a time as you scroll, so even huge camera rolls open
  instantly, and the app reopens wherever you left off.
- **Live Photos and HEIC images now preview throughout Drive**, including HEIC
  thumbnails, reliable repeated Live motion playback on supported systems, and
  an immediately disabled LIVE badge with an explanatory tooltip on Linux.
- Drive, Billing, and Support information tooltips now link directly to their relevant
  documentation.
- **Release pages now name the file to download** for each platform, and publish a
  checksum for every file so you can confirm a download arrived intact.
- **Share links can now expire.** Choose 24 hours, 7 days, 30 days, or until you revoke
  it — both in the app and when right-clicking a file in Finder on Mac.
- **Password-protect a share link with your own password**, from either place.
- **Your computer stays awake while files are transferring.** Long uploads no longer die
  when the machine goes idle. The screen can still switch off, and closing the lid still
  puts the machine to sleep as normal.

### Changed

- **Uploads are substantially faster**, especially on slower or long-distance
  connections — parts of a file now transfer at the same time instead of one after
  another.
- **Much faster startup for large libraries.** On a test account with 275 GB and 73,000
  files, the "preparing" step after relaunching or waking the computer drops from around
  30 minutes to seconds. Requires the matching server update to be live.
- **Lighter on your machine when idle** — less background activity when nothing needs
  syncing.
- Uploads made from the desktop app are now labelled as such in your account's usage
  breakdown, instead of being counted as "other".
- The information tooltip on the Files page now explains what the page actually holds:
  the folders you sync from this computer, and why your unlock password is needed to
  open them.

### Fixed

- **Excluding a file from the "Sync Issues" dialog now sticks**, including names with
  brackets or braces such as `Movie [2019].mkv`. Before, the file kept failing, the dialog
  kept coming back after every restart, and in some cases a differently named file was
  excluded instead. Retry now clears such a stale exclusion too.
- **Photo thumbnails show real previews again.** Small preview images in the
  file grid and the viewer's filmstrip could appear as broken-image icons even
  though the photos themselves were fine.
- **Huge photo folders no longer freeze the app.** Browsing or previewing a
  folder with thousands of pictures could lock everything up with spinners
  that never finished; thumbnails now load only as they come into view, and
  much faster.
- **Photos now show up when you open them.** Clicking the eye icon on an image
  could leave a loading spinner turning forever, even though the picture had
  already finished loading behind it.
- **Linux updates no longer fail with a permission error.** On a `.deb` install, Hippius now opens the GitHub Releases page so you can download the new package, instead of trying (and failing) to install it from inside the app.
- **macOS no longer asks "Hippius would like to access data from other apps"
  every time you open the app.** Answering Allow never made it stop; the prompt
  is now gone entirely, and Finder right-click sharing works exactly as before.
- **Uploading a file that already exists no longer replaces it silently.** The previous file stays; a confirmed replace is a follow-up.
- **A finished delete is titled as a delete**, not "Sync Complete".
- **Syncing a folder from another device uses the folder you picked.** Choosing the existing folder no longer creates a nested copy with the same name.
- **The subscribe offer still shows if plan prices fail to load**, instead of looking like you are already on the top plan.
- **Plan sizes on Billing now match the marketed amounts.** The 3 / 150 / 450
  credit plans show 1 TB / 50 TB / 150 TB instead of 999 GB / 49 TB / 149 TB.
- **Downloaded folders keep the original file dates.** Zip entries no longer
  all show 1 January 1980.
- **A folder you remove from this computer is not labelled with this
  computer's name.** It stays under "Not synced on this computer" without
  repeating the device line.
- **Home storage used, total, and free now add up.** Remaining space uses
  the same unit and decimals as the total, so a card no longer reads
  “31.91 GB of 5.03 TB used” next to “5 TB free”.
- **Hidden files no longer reappear in Drive as waiting to sync.**
- **A folder's size and file count now leave out the files you excluded.**
  Excluded files still show in the folder (they are not uploaded); the row
  numbers match File No, which also skips them.

- **The low-credits warning clears after you add credits.** The bell no longer
  showed an unread "you're running low on credits" notice next to the one saying
  your credits had just landed.
- **Closing the window on Linux and Windows now quits Hippius.** The app
  no longer leaves a background process running after you click the window X.
- **`--version` prints the version and exits.** Running Hippius with `--version`
  or `-V` no longer opens the full app.
- **Folder sizes stay correct as you work.** A folder's size and file count now
  update right away when you delete or add something inside it, or when a file
  arrives from another device — previously they could keep showing the old
  numbers until the app was restarted.
- **Adding a large folder no longer freezes the app.** Dropping a multi-gigabyte
  folder in used to lock the window until the copy and encryption finished.
- **Sync complete notifications name the file.** A single finished file shows
  its name in the bell; several files show how many.
- **Replacing an already-synced file can no longer upload a half-copied version.**
  Adding a file over one you already had could, if the copy was slow, be picked up
  while it was still being written and back up an incomplete copy.
- **Adding a folder no longer counts hidden files in the file total.**
- **A folder's file count updates as soon as you add to it.** Adding a file or
  folder could leave the count in Drive showing the total from before the upload
  until something else changed that folder.
- **Filters and search now work while browsing inside a folder.** Applying a file-type,
  date, size, or search filter inside a synced folder — including folders synced from
  your other devices — quietly kept showing the full unfiltered list with the filter
  chip still on.
- **A failed update now tells you what to do next.** Instead of "Please try
  again later", Hippius names the problem and links to the download page for
  your release channel, with the right instructions for how your copy was
  installed.
- **The Mac download list no longer offers a file that installs an incomplete copy.**
  Release pages carried a second Mac file next to the disk image that read as an
  alternative download but was missing "Share with Hippius" and Apple's security
  check. It is gone from current releases and will not appear on new ones.
- **Files you exclude with a pattern like `*.bin` stay in Drive as excluded.**
  They are not uploaded, they do not count toward File No or storage totals,
  and Recent Files no longer shows them. Clearing the pattern brings them
  back to a normal row without a manual refresh. Folders you exclude
  (`node_modules/`) still stay off Drive.
- **An exclusion pattern that can't work is refused when you type it.**
  Previously a malformed pattern was saved and listed as active while
  quietly excluding nothing.
- **Updating on a Mac no longer removes "Share with Hippius".** Installing from the
  disk image gave you the right-click share menu, but every automatic update after
  that quietly replaced Hippius with a copy that did not include it — so the feature
  disappeared and could not be switched back on from Settings, because it was no
  longer there to switch on. Updates now install the same complete, Apple-checked
  copy the disk image contains. If yours went missing, reinstall from the disk image
  once; updates from then on keep it.
- **Files that vanish before upload no longer mark the whole sync as Failed.** A
  temporary file that the app or the system deletes mid-sync used to leave the sync
  widget, the tray icon and the tray panel showing a red "Failed" at 100%, even
  though every file you actually cared about had synced. Genuine failures still
  show as before.
- **"Share with Hippius" now registers itself on Mac.** On some Macs the right-click
  menu never appeared no matter what you did in Settings, because macOS had never
  registered the feature at all — so it was not in any list to switch on. Hippius now
  registers it at startup, and the notice explains what to do when it is missing
  entirely rather than assuming it is only switched off.
- **Storage on the home page no longer sticks at 0 B right after a sync.**
- **"Share with Hippius" now turns itself on.** On Mac, the right-click share menu was
  missing on new installs, and the notice about it sent you to a Settings list that
  often did not contain Hippius at all. The notice now has an **Enable** button that
  switches the feature on for you, and only falls back to opening Settings if that does
  not work. Opening Hippius straight from the downloaded disk image no longer shows that
  notice at all — nothing there can turn the feature on, so it now just asks you to move
  Hippius to your Applications folder first.
- **File search understands patterns like `*.pdf`.**
- **Every build now reports its real version number.** Installed copies all claimed to
  be version `0.0.1`, so there was no way to tell which build you were running when
  reporting a problem.
- **A folder you remove from this computer is listed as not synced here, not as
  if it came from another device.**
- **Reclaimed disk space lost to interrupted uploads.** While preparing an upload,
  Hippius writes a temporary encrypted copy of the file. Copies left behind by uploads
  that were interrupted — by a dropped connection, a pause, or quitting the app — could
  pile up until the drive ran out of space. Hippius now clears out the leftovers every
  time it starts, and when you remove a synced folder. Existing users get the space back
  automatically on the next launch; there is nothing to run or delete by hand.
- **Sharing a second file** showed the first file's link instead of starting fresh.
- **Progress indicators no longer give up** part-way through preparing a large folder.
  They used to reset while the app was still working.
- **"Sync Now" no longer looks frozen** after reviewing changes, and now tells you
  clearly when a sync is already running instead of leaving the button spinning.
- **The Review Changes screen reflects your choices.** Selections highlight correctly,
  and your decisions are no longer wiped while you are still making them.
- **Deleted folders disappear immediately** instead of lingering until you navigate away
  and back.
- **Fewer failed sign-ins** with Google, GitHub and Apple. Clicking sign-in twice, a slow
  server, or the app restarting mid-sign-in no longer leaves you stuck.
- **Sessions survive everyday interruptions.** A temporarily locked system keychain no
  longer signs you out, and signing out of one account no longer disturbs another.
- **You now get a clear message when your session expires**, instead of syncing quietly
  failing in the background.
- **Windows builds work again.** A packaging fault had been blocking Windows releases
  entirely; Windows is now covered by automated testing so it cannot recur unnoticed.

### Security

- **Password-protected share links can no longer be copied as unprotected links.** The
  Shares page could hand out a password-free link for a file you had explicitly
  protected.
- **Your access token is no longer stored in browser storage.** Sign-in now relies on the
  app's own protected storage, so a copy of your profile folder no longer exposes a
  usable credential.
- **Sign-in links are no longer written to log files**, so a support log can never carry
  a working credential.

---

## Earlier releases

Version `0.2.1` and everything before it predates this file. `0.2.1` itself was an
internal release-validation build, never distributed to users, and the versions before
it were released without written notes — so rather than reconstruct them after the fact
and risk saying something inaccurate, they are left out here.

For the raw history of those builds, see
[Releases](https://github.com/thenervelab/hippius-desktop-internal/releases).

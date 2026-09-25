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

### Changed

- **Sharing drives and folders is part of the Plus, Max and Scale plans.** On
  Free and Starter, the Share dialog and Manage access show a short note with
  an "Upgrade plan" button in place of inviting people or creating links. You
  can still see who has access and remove people or links.
- **Shared drives have two roles, Viewer and Editor.** Only the owner invites and removes people.
- **Sharing a drive or folder happens in one Share dialog**, with inviting
  someone by email and creating a link as two separate steps, so typing an
  address never turns a link into an invitation by mistake. Problems are
  explained right where they happen, and the dialog stays open so you can
  invite several people in a row.
- **The Share dialog shows who has access**: the owner, everyone in the
  drive or folder, and invitations still waiting. You can change someone's
  role or remove them right there, approve an emailed invitation that is
  waiting for you, and revoke a link you just made.
- **Manage access is one list** instead of tabs: the people who have the
  drive or folder, invitations still waiting, and every link with how often
  it was used and when it expires, all in one place.
- **Manage access stays easy to read on a big drive**: it shows the newest
  six people and three invitations, and up to ten links in full, each with
  its link ready to copy. A bar at the top jumps
  between people, invitations and links, and "Show all" opens a list you can
  search and filter. Long names and emails are cut short instead of running
  under someone's role.
- **Changing which folders someone can open now lets you add a folder**, as
  Viewer or Editor, not only take folders away.
- **Storage and plan banners on Overview use a button on the right**
  (Upgrade, See storage plans, Top up). Drive keeps an underlined text
  link under the banner copy so it does not duplicate the plan-chip
  Upgrade in the header.
- **Over-quota banners are red** (same danger treatment as no-plan), on
  Overview and Drive, for free and paid plans — uploads are paused.

### Fixed

- **A frozen shared drive now says until when in plain words**, instead of a raw timestamp.
- **Accounts that sign in with an access key or a wallet no longer show a made-up
  `@hippius.local` email.** The account menu, sharing and Manage access show the
  name or the wallet address instead.
- **Sync Queue when storage is full (HTTP 402).** Failed uploads say
  "Storage full. Upgrade your plan or free up space." instead of
  "Server error (402). Please try again." Credits-exhausted failures still
  show the credits wording. Files added to a sync folder while over quota
  fail with the same clear message.
- **Overview and Drive when you have no plan, or you are over Free / paid
  storage.** File, Folder, and Sync look disabled and do not open a picker
  or dialog on click. Drag and drop still explains with Subscribe (no plan,
  including the 30-day deletion notice) or Upgrade (full plan, files stay).
  Right-click upload items are disabled the same way. Backend write checks
  remain the last line of defence.

### Added

- **Share one folder as a Viewer or Editor** (internal test builds only for now), by a single-use link or by email. People you share a folder with see it under Shared with me, can open it without seeing anything above it, and can do what their role allows. Whatever the server does not offer yet (single-folder sharing, Editor on a folder, email invites) says "coming soon" instead of disappearing.
- **Editors can share a folder by link from a drive someone else owns.** Viewers and frozen drives do not see the option.
- **Invite people to a shared drive by email.** The owner can send a single-use invitation from the Share dialog, see where each one is on the Links tab, and approve it once the person opens it.
- **Shared drives show people by name.** Members, invite links, Shared with me, the Added by column and File Details name each person, with their full address and email on hover.
- **Drive remembers how many rows you chose.** Pick 50 per page and it stays 50
  — in other folders, after visiting another page, and next time you open the
  app. The rows-per-page control also stops disappearing on folders that fit on
  one page, which used to leave you stuck on a size you could not change back.
- **Team chat: end-to-end encrypted channels and direct messages with your
  Hippius account, in the app.** Sign in with your Hippius account (no password
  to remember), and the same recovery key the web console uses unlocks your
  message history here too. Read and write in channels, direct messages and
  threads; react, reply, edit and delete; share images and files, and save
  what others send you straight to disk. Available on staging builds first.
- **Chat keeps you posted while you work elsewhere in the app.** A direct
  message or a mention in a channel shows a system notification (turn it off
  under Settings → Notifications → Chat), and the number of unread DMs and
  mentions appears on the app's dock/taskbar icon, in the window title and in
  the tray popover — even when you are not on the chat page.
- **Chat workspaces, like the web console.** A rail on the left lists the
  workspaces you belong to with their unread counts; create one, join the
  Hippius community, or paste an invite link to join a team. The channel list
  follows the workspace you pick, and the app reopens where you left off in
  each.
- **Share a drive with someone.** Drives on a Plus, Max or Scale plan can be
  shared: invite someone by link, choose what they can do, and manage who has
  access. Starter plans do not include shared drives, so the option is not shown.
- **Shared drives show who they belong to and what you can do in them.** A drive
  someone shared with you is marked in your drive list and says whether you are a
  Viewer or an Editor, instead of looking exactly like your own drives.
- **Choose what an invite grants.** Inviting someone to a drive now asks whether
  they join as a Viewer (open and download) or an Editor (also upload and delete),
  and says what the link allows before you send it.
- **The Drive toolbar stays put as you go deeper into folders.** New Folder,
  upload and the rest sat at the right edge until a long breadcrumb pushed them onto
  a second line, where they jumped to the left. They hold the right edge either way now.
- **Uploading and dropping files inside a shared drive works.** Opening a folder
  inside one lost track of the drive, so uploads quietly went to a folder on this
  computer instead. Drag and drop works there too.
- **Viewer and Editor now read as coloured badges**, the same ones the
  web console uses, so a list of drives can be read for access at a glance.
- **The Drive breakdown cards no longer list categories nothing is in.** A drive
  uploaded only from the console showed "Desktop 0", "Mobile 0" and "Other 0"
  under the bar; those rows are gone.
- **The file-types card no longer says "(before tracking)".** That caveat is true
  of where a file was uploaded from, which older files do not record, but a file's
  type has always been known.
- **An Editor can upload into a shared drive they are only browsing.** That used
  to need a copy of the drive on this computer.
- **Drives shared with you show their size, file count and last change**, the
  same facts your own drives show. A drive whose figures have not arrived yet
  shows none rather than claiming to be empty.
- **Drives shared with you read like your own drives.** Each row shows a folder
  icon, its role as a badge, and a menu with Open, Sync to this computer and
  Leave drive.
- **You can leave a shared drive you never synced.** Leaving used to require a
  local copy of the drive first.
- **Open a drive somebody shared with you without copying it to this computer.**
  Clicking a drive under "Shared with me" opens it and browses its folders and
  files, the same way a drive you keep only in the cloud does. Syncing it locally
  is still there when you want a copy on this machine.
- **The drive list's pager is readable in dark mode.** Its page numbers were
  white tiles on a dark page.
- **Your drive list pages once it gets long, so "Shared with me" stays in view.**
  Drives other people shared with you sit below your own; with a lot of drives
  they were pushed off the bottom of the page.
- **Sharing a drive is offered on every plan, and says what it costs.** Picking it
  on a plan that does not include shared drives opens an upgrade prompt naming Plus,
  Max and Scale, rather than the option being hidden with no explanation.
- **A Viewer is no longer offered uploads they cannot make.** On a drive shared
  with you as a Viewer, the upload buttons are absent rather than failing later
  as a sync error. Editors are unaffected.
- **Changing a role says what it costs before you save it.** Demoting someone now
  warns that the invite link which admitted them is revoked too.
- **File Details says who uploaded a file in a shared drive.** Opening a file in
  a drive you share shows the person who put it there, or "You" when it was you.
  Files on your own private drives are unchanged — there is only one answer there.
- **A shared drive says so from the inside too.** Opening a shared drive shows
  the badge and, if it is yours, a Manage access button beside the breadcrumb —
  previously the only sign a drive was shared disappeared the moment you opened it.
- **Change someone's role without removing them.** Each member in the list has a
  menu offering Change role and Remove from drive; changing a role opens a dialog
  that says what the new role grants before you save it. Previously the only way
  to change what someone could do was to remove them and invite them again.


- **The Overview shows what is in your Drive.** A card breaks your files down by
  type (images, videos, docs, others), and a tab switches it to show where they
  were uploaded from (desktop, console, mobile), the same picture the web
  console shows.
- **The plan card is out of the way inside folders.** It still sits at the top of
  Drive, but opening a folder gives the space back to the breadcrumb and the files.
- **Billing leads with your balance and your next charge**, side by side. The TAO
  deposit address card is gone from that row.
- **Billing now shows what you will be charged next.** A card beside your balance
  names the plan, the amount, when it renews and what pays for it, instead of that
  only appearing as a warning once your balance was too low to cover it.
- **Your plan's charge history is back on Billing.** Every charge, renewal and plan
  change for your Drive plan, with what it cost and whether it went through.

- **Right-clicking anywhere on Overview or Drive now opens Hippius's own menu**
  instead of the browser's Back / Reload / Inspect menu, with Upload File, Upload
  Folder, New Folder, and Sync a Folder where each applies.
- **You can create an empty folder.** New Folder works inside a synced drive, inside
  a drive you are only browsing, and from Overview — where it asks which drive.

- **File Details now shows the file's Arion hash** (the BLAKE3 content digest)
  so you can copy it or open it on the file tracker.
- **Finder shows how each file in your Hippius folders is doing.** Files and
  folders carry a badge in Finder: synced, syncing, shared by link, or failed.
- **Hippius tells you when a folder lives inside Google Drive, Dropbox, OneDrive
  or iCloud Drive, or on Desktop, Documents, Downloads or Applications.** Those
  folders still sync. Finder badges and "Share with Hippius" cannot appear
  inside another provider's folder, and syncing waits for that provider to
  download each file. Finder may also skip badges on Desktop, Documents,
  Downloads and Applications. The folder row and the add-folder dialog now
  say so.
- **Choose a storage plan without leaving Hippius.** A new Subscription Plans page
  under Account lists every plan with what it includes, shows the one you are on,
  and lets you subscribe, upgrade, downgrade or cancel. Pay from your credits, or
  by card through Stripe in your browser.
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

- **Support tickets now ask what your question is about.** Pick Drive & sync,
  Shared drives, Credits & payments, Subscription, Account & sign in, Feedback
  or Other, instead of the old "Storage (Arion & S3)" catch-all, which also
  offered S3, something the app does not do.
- **Search starts at three characters.** In the sidebar search and when searching a
  folder that is not synced to this device, one or two letters now show "Type at
  least 3 characters" instead of a misleading "no results".
- **Sharing a folder as a link is no longer offered on a drive shared with you.**
  Only a drive's owner can mint a folder link, so the action used to be offered
  and then refused after you had chosen an expiry. Sharing a single file from
  such a drive still works.
- **A drive shared with you as a Viewer no longer offers you upload controls.**
  New Folder, Folder and File are hidden on a drive you can only read, and a file
  dropped onto it is refused with a line saying you have Viewer access and should
  ask whoever shared the drive to make you an Editor — instead of a failed upload.
- **Files are now shown a page at a time.** Drive and the folders inside it show
  15 rows with a pager underneath and a size control, instead of a list that grows
  as you scroll, and the loading placeholder is the size of the page you are about
  to get. Searching or filtering still looks across the whole drive, not just the
  page you are on.
- **The light / dark switch is now in the account menu.** Pick Light, Dark or
  System straight from the menu in the top right, instead of going to Settings.
  It is the same setting, so changing it either way keeps them in step.
- **Your balance is now shown in dollars.** What was "Total Credits" is now your
  account balance, quoted as "$5.13" rather than a token amount, everywhere it
  appears. One credit has always been one dollar; now you do not have to know that
  to read the number.
- **The Overview's plan card is gone, and its Manage button moved.** The storage
  card beside it was already showing the same plan name and allowance, so the two
  said one thing twice. Manage and Upgrade now sit in the storage card, next to the
  reading they act on.
- **The Plan card no longer says "about" the size of your plan.** A 500 GB plan is
  exactly 500 GB, and the "≈" made an exact number look like a guess.
- **A clearer line under "Welcome to Hippius".** The app is about your Drive, so the
  subtitle says so instead of mentioning compute.

- **Clearer names in the folder menu.** "Pause syncing", "Sync exclusions…",
  "Stop syncing on this device" and "Delete from Hippius" replace wording that did
  not say what each one affected. Stopping sync is no longer coloured like a
  deletion — it leaves your files alone — and deletion now sits last on its own.

- **A drive already synced to this computer no longer offers "Browse Contents".**
  That option picks which parts of a drive to sync, which is a question an
  already-synced drive has answered; Open shows its files. Drives not synced here
  keep it.

- **If your account has no storage plan, the Overview page now says so plainly.**
  A red notice above the Storage and Plan cards warns that files you have already
  uploaded are permanently deleted after 30 days without a plan, and that you
  cannot upload anything new until you subscribe, with a link to the plans. The
  Storage card itself no longer shows a full red bar, which looked like your
  storage was full rather than absent.
- **The Storage and Plan cards no longer stretch across very wide windows.** They
  keep a comfortable maximum width instead of spreading into empty banners. The
  rest of the page still uses the full width.
- **The upload buttons are tidier.** The icon sits closer to its label, and on the
  Drive page the icon now matches the size of the text beside it instead of
  looking oversized.
- **Subscription plan cards are less cluttered.** Each plan states its price once
  instead of repeating it underneath as a credits charge.
- **The plan card in the page header is much smaller.** It used to grow to four
  stacked lines when an account was low on credits — the moment it was most in the
  way. The usage bar and its numbers now share a line, the low-credits warning sits
  beside the plan name, and the button reads "Top up".
- **The Upgrade and Top up buttons now look like the actions they are.** They are
  filled brand buttons rather than plain pills, so they stand out from the
  navigation buttons around them.
- **The upload buttons are shorter and clearer.** They now show an upload arrow with
  "File" or "Folder" instead of "+ Upload File" — the plus suggested creating
  something new, when these upload something you already have.
- **Security and API Token warnings now match the rest of Settings.** They
  sit in the same card style as the rows around them, instead of a yellow box.
- **Billing's credits and deposit cards have more room inside**, so the
  balance, address, and buttons are no longer packed together.
- **Finder badges on your files are easier to see.** They fill the badge well
  instead of sitting small inside it.
- **Your storage is now measured against your plan.** The home page shows how much
  of your plan's storage you have used, and names the plan you are on — including
  the free plan, which every account has. It previously showed how much storage
  your credit balance could buy, which is not the same thing as the space you have.
- **Plan cards no longer suggest shared drives are ready to use.** The shared team
  drive line is greyed out on the plans that include it, until the feature is
  switched on.
- **Choosing how to pay is simpler.** The two ways to pay sit side by side, with
  card first and picked for you, since paying from credits needs a balance you may
  not have yet. The card option shows the cards and wallets the checkout accepts,
  and one line underneath explains whichever you have picked. If your balance will
  not cover the plan you can still open the credits option, so you can see how far
  short you are and top up from there.
- **Every upgrade and top-up prompt now goes to the same place**, the Billing page
  in Settings. The separate Subscription Plans page is gone — it showed a subset of
  what Billing shows, so the two prompts used to lead to two different screens.
- **Billing and plans are one place instead of two.** "Subscription Plans" and
  "Billing" were separate sidebar entries for the same subject. Your Drive plans
  now live inside Billing, and Billing has moved into Settings.
- **The folder path now starts at "Drive"** wherever the folder is synced, instead
  of "Local" or "Remote". Clicking it returns you to the full folder list.
- **Getting back out of a folder is obvious now.** There is a back button next to
  the folder path, and the path itself is easier to read. Before, the faint trail
  of folder names was the only way out.
- **You can upload straight from the folder list**, without opening a folder first.
- **You can sign in with Apple.** The button was there but permanently greyed out;
  it works now.
- **Uploads into a folder you are browsing show in the sync queue**, alongside
  everything else being synced, instead of a message that sat on screen for the
  whole upload.
- **The share button is back on files you are only browsing.** Opening a file from
  a drive that is not synced on this computer showed no share option; it does now,
  and the link works the same way.
- **Folders expand inside drives that are not synced on this computer.** The arrow
  next to a folder did nothing there; it now opens the folder in place, the same as
  it does for folders synced here.
- **Search works inside folders that are not synced on this computer.** It now
  searches the whole drive, including subfolders you have not opened, the way it
  already did for folders synced here.
- **You can create folders in drives that are not synced on this computer.**
- **You can now upload into folders that are not synced on this computer.** Open a
  folder you are only browsing and add files to it directly; they go straight to
  your Drive without downloading the folder first.
- **You can rename files in folders that are not synced on this computer**, from the
  same menu as anywhere else, without downloading the folder first.
- **Clicking a folder in Settings opens that folder**, instead of dropping you on
  the Drive page to find it again.
- **All your folders are in one list.** The Drive page split them across three
  headings — folders on this computer, folders from other devices, and folders
  synced nowhere. They are now a single list, each row showing where that folder
  actually is: a cloud mark for the ones not on this machine, and a line naming
  the device that has it.
- **Drive always opens on your full folder list.** It used to reopen wherever you
  last were, which left no reliable way back to the top — clicking Drive in the
  sidebar returned you to a folder rather than the list. This replaces the
  "reopens where you left off" behaviour added in 0.6.0.
- **The button in the top corner now offers what your account actually needs.**
  On the free plan it offers to upgrade instead of topping up credits, which buy
  no Drive storage. On a plan it shows how much of your storage you have used, and
  offers an upgrade once you pass 80% — or a top-up only when your credits will not
  cover the next renewal. A healthy plan is not sold anything. The same cell now
  behaves this way on the Drive page as well as the overview.
- **Billing no longer mixes in plans for a different product.** The credit-reload
  packages and the billing history table have been taken off the page, so it shows
  the plan that governs your Drive storage and the credits that pay for it.
- **"Confidential Computing" is gone from the sidebar.** The entry held only
  Virtual Machines, which is not available yet, so it advertised a section that
  led nowhere.
- **The upload buttons say what they do.** "+ New Folder" and "+ Add Files" are now
  "Upload Folder" and "Upload File", worded the same way everywhere they appear.
  The old wording suggested you could create a folder in the app, which was never
  possible — both buttons send something that already exists on your computer.
- **Setting up a folder to sync reads differently from uploading one**, so the two
  are no longer easy to confuse.
- **Shared drives are hidden until they launch.** Sharing a drive with someone and
  the "Shared with me" list are not available in this release, matching what the
  plan cards say. Drives already set up keep syncing as normal.
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
- **Drive now shows your plan and how full it is.** The Drive page header carries
  the same plan card as the home page — which plan you are on, a bar showing how
  much of it you have used with the figures and percentage below it, and an
  Upgrade or Top up Credits button when you need one — in place of the old
  Subscription Plans button. It stays with you inside every folder.
- **The plan in the page header says how much storage is left.** On the free plan
  it showed only the size of the allowance; the header now states what you have
  used out of it, and what percentage that is. A subscribed account is headed by
  its plan's name rather than a generic "Active Plan".
- **You are told before a plan fails to renew.** When your credits will not cover
  the next cycle, the page header and the billing page say so and count down to the
  renewal date, and a single notification is raised in the ten days before it —
  once per billing cycle, not once a day.
- **A drive with no folders yet explains what to do.** The folder list showed an
  empty panel; it now says the list is empty and offers to sync your first folder,
  on both the Drive page and in Settings.
- **The home page no longer repeats your plan in the header.** The Storage and Plan
  cards below it already say all of that, with the room to say it properly.
- **The plan card no longer quotes your monthly price back at you.** It shows the
  plan and its storage; billing detail is behind Manage.
- **A plan with room left ends cleanly.** The page header no longer leaves an empty
  gap where an Upgrade button would have been.
- **You can upload straight into a drive that is not synced on this computer.** The
  folder picker in the upload dialogs now lists those drives too, for files and for
  whole folders, marked so you can tell them apart. Inside such a folder there is now
  an Upload Folder button beside Upload File and New Folder.
- **The Drive page tells you when your plan needs attention** — a renewal that
  failed, a cancelled plan, or one still being set up — reading the same source the
  web console reads, so both say the same thing.
- **A brand-new account is shown the storage plans on the Drive page**, under the
  empty state, instead of an empty page with nothing to do next.

### Fixed

- **A drive that could never finish syncing now finishes.** Files the app
  could not unlock were downloaded again on every cycle forever, so the drive
  reported "syncing" without end and never caught up. They are now retried
  once, then set aside, and the sync moves on.
- **Deleting files is no longer stuck behind a long upload.** Removals now
  happen first, so a drive with a large backlog stops showing files you
  already deleted and stops paying to store them.
- **A file that can't be unlocked says so, and no longer offers a retry that
  does nothing.** It used to read "Sync failed. Please try again" and show a
  retry button — both wrong, because trying again never helps for these. It
  now tells you the file needs to be uploaded again or removed, and the retry
  button is gone for it (Skip and Exclude still work).
- **Downloading and sharing a file from a drive someone shared with you now
  works.** Both refused with "no local key material on this device" on a shared
  drive you are browsing rather than syncing — including for a Viewer, whose only
  way to use the drive is to open and download from it.
- **Hovering the Drive breakdown now tells you what a bar is.** The file type and
  upload source charts on Overview showed coloured bars with no way to read one;
  hovering now names the category, its file count and its share, and the rest of
  the chart dims so you can see how far that category runs.
- **The file types chart explains its grey bucket**, the same way the upload
  sources chart already did.

- **"Sync needs your unlock password" no longer appears when nothing is wrong,
  and no longer sends you to the sign-in screen.** The notice could stay up on a
  device that was perfectly fine, and pressing it looked like being signed out.
  It now checks and disappears on its own, and only asks for your seed phrase
  when that really is the only way back.
- **The sync notice and the encryption password dialog are readable in dark
  mode.** Both were drawn in light colours whatever theme you were using.

- **Hippius repairs a local database left over from a much older version.** If you
  had installed Hippius long enough ago, one leftover table could stop the app
  setting up its local storage at all — so signing in failed every time, on every
  launch, and reinstalling did not help because the old file was still there. That
  file is now upgraded on the next launch, with nothing for you to do.
- **One part of local storage failing can no longer take out the rest.** A single
  problem used to discard every table, leaving an app that opened normally but
  could not save anything. Each part is now handled on its own, and if the pieces
  sign-in depends on are genuinely unavailable Hippius says so instead of failing
  silently at the end of every sign-in.

- **The app now tells you about a new version while it is running.** Updates were
  only ever found when you restarted Hippius or checked by hand, so a copy left
  open for days never offered one. It now checks in the background and offers the
  update once, without nagging.

- **Folders in a cloud drive now show a date.** They showed a dash where the files
  beside them showed the date they were uploaded; a folder now shows when it first
  appeared.

- **Sorting a folder now sorts the whole folder, not just the page you are on.**
  Sorting by name or size used to reorder only the rows on screen, so the order
  broke as soon as you turned the page.
- **Plan charges show their status again.** The Status column in your plan's
  charge history was blank for completed and paid charges.

- **Signing in with Google or GitHub no longer runs out of time while you are still
  signing in.** You had five minutes to finish in the browser, so creating your
  account or clearing a two-factor prompt could quietly use it up — and once it did,
  reopening the link from the browser could never work either. The window is now
  thirty minutes, and Hippius says when a sign-in has expired and that you need to
  start it again from the app.
- **A sign-in that fails now tells you why**, instead of always saying "Failed to
  complete authentication. Please try again." If Google or GitHub refused the
  request, you see their reason.

- **Right-clicking outside your files no longer offers New Folder.** The menu
  appeared on every page — Settings, Security, Notifications — where there are no
  folders to create one in. It is now limited to Overview, your drives and the
  folders inside them, and right-clicking a text field offers Cut, Copy and Paste
  again.

- **Storage bars are visible in light mode again.** The groove behind the bar was
  almost the same colour as the card, so a drive with little used looked like it
  had no bar at all.

- **The folder menu's actions work again.** Pause syncing, Sync exclusions and the
  rest all opened the folder instead of doing what they said, because choosing an
  item also registered as a click on the row behind it.

- **Folders that are not synced on this computer can be opened again.** Drives
  shared with you, and your own drives from other devices, did nothing when
  clicked on some screens — so their files could not be browsed at all.

- **The Billing page's help tooltip is now a short guide.** It repeated the
  subtitle word for word; it explains the two ways to pay for a plan instead —
  by card through Stripe, or from your credit balance — and links to the billing
  documentation.
- **The low-credits warning now explains itself, on the page where you can fix
  it.** Billing shows a red card naming your plan, what it costs a month, your
  balance, and when the renewal falls due — replacing a one-line amber note that
  only said credits were low, and which had stopped appearing on Billing at all.
- **Plan prices are quoted in dollars everywhere.** The dialog that confirms a
  subscription used to describe the same price in credits that the plan card had
  just shown in dollars. Credits are still named where they are the subject — the
  balance, topping up, and the credits payment option, which states that one
  credit is one dollar.
- **The API token screen is no longer part of Settings.** The token is for
  calling the Hippius API from scripts and the console, not from the desktop app.
- **The Free plan card no longer claims to be your current plan when it isn't.**
  Subscribers saw it labelled "Current Plan" beside their actual plan's Cancel
  button; it now reads "Default Plan", the one you return to if you cancel.
- **Accounts signed in with an access key no longer see the Free plan at all.**
  They are not entitled to it, so offering it was misleading — and cancelling a
  paid plan now says plainly that it leaves them without storage.

- **The rename dialog closes as soon as you confirm.** It used to stay on screen
  until the rename finished, which on a cloud folder could take several seconds;
  progress now shows in the notification instead.
- **Renaming a folder in a cloud drive now works, and takes its contents with it.**
  Renaming a folder you are browsing but not syncing either failed outright or
  moved the folder while leaving every file inside it under the old name.

- **Renaming a folder works again.** Renaming a folder inside another folder failed
  with an error, because the app looked for it at the top of the drive instead of
  where it actually was.
- **The billing cards are sized for what they hold.** The deposit address was being
  shortened on a window with room to spare, and on a large screen both cards
  stretched into empty space. They now stop at their natural width, with the address
  shown in full.
- **The Drive plan notice is easier to read.** The cancelled-plan and failed-renewal
  warnings now match the web console's style instead of filling a block of colour.
- **The account menu says who you are signed in as.** It showed only your wallet
  address; it now leads with the email or handle you signed in with, with your
  address below it, and the open menu names your account, your email and which
  service you signed in with — matching the web console. Your email and provider now
  survive a restart, so the menu no longer forgets who you are after relaunching.
- **The Excluded filter only appears when you have excluded something.** It used to
  show on every drive, where pressing it could only ever return nothing.
- **Upload Folder and Sync a Folder are easier to tell apart.** They are separated on
  the toolbar and each says what it does, so a one-time copy is not mistaken for
  setting up a folder that stays in sync.
- **Renaming a file inside a folder that is not synced on this computer works.**
  The option was there but greyed out; only folders could be renamed. The new name
  now appears straight away instead of after leaving the folder and coming back.
- **Large files upload to a cloud folder again.** Uploading a big file into a folder
  that is not synced on this computer failed with a server error at the very end of
  the transfer. Files of any size now go up the same way they do for a synced
  folder, still encrypted on your machine before they leave it.
- **You can see that a cloud upload started, and it stays in the list.** Uploading
  into a folder that is not synced on this computer now shows a brief confirmation
  that the upload has begun, and the files stay in the sync list until your next
  upload instead of disappearing a few seconds after they finish.
- **A folder added from Settings gets Finder badges right away**, not after
  the next launch, and a removed folder stops showing them.
- **The "Turn on the Hippius Finder extension" notice no longer comes back after
  you enable it and relaunch.** The app now waits for macOS to confirm the
  switch before recording that it is on.
- **"Share with Hippius" in Finder switches itself on.** On a Mac it is turned on
  for you on the first launch and comes back by itself after a macOS or Hippius
  update, instead of asking you to turn it on. If it is ever off, Hippius asks once
  per launch, with a "Don't ask again" option, and Settings › Sync & Storage has a
  switch for it.
- **Uploads and share links work again on every paid plan.** Some accounts saw
  "This would go past the storage your plan includes" with plenty of room left;
  Hippius now checks with the server before refusing, instead of working it out
  on its own.
- **Uploads now stop when your plan is full, instead of failing later.** An upload
  that would go past your plan's storage is refused up front with a link to the
  plans page — the same answer the web console gives. Accounts on the free plan
  were previously allowed to keep uploading here after passing their limit.
- **A full plan now always points you at the plans page.** Adding a folder from
  Settings, uploading into an existing folder, or creating a share link while your
  Drive is full used to end in a plain error message with nowhere to go; all three
  now open the same "Not enough storage" prompt as the other upload paths.
- **Excluding a file from the "Sync Issues" dialog now sticks**, including names with
  brackets or braces such as `Movie [2019].mkv`. Before, the file kept failing, the dialog
  kept coming back after every restart, and in some cases a differently named file was
  excluded instead. Retry now clears such a stale exclusion too. Files you untick in the
  folder browser are covered by the same fix.
- **Dismissing the "Sync Issues" dialog now sticks.** It no longer comes back every couple
  of minutes, or after every restart, for files you have already seen. It reopens only
  when a new file starts failing, and then lists everything that needs attention.
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

- **Unlocking and setting the unlock password can no longer overwrite your files' keys.**
  Now that an unlock password can also be set from Hippius Console, unlocking with a
  password that protects a different seed than the one this device's files were
  encrypted with is refused with nothing changed, and "Set Unlock Password" refuses to
  replace an unlock password that was already set elsewhere.
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

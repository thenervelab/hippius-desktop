import Cocoa
import FinderSync

/// The Hippius Finder Sync extension.
///
/// Per Apple's guidance the extension does no heavy work: it renders the
/// right-click menu and status badges and forwards the clicked path to the
/// running Hippius app over the bridge socket ([`BridgeSocket`]); the app
/// resolves the path and mints the share. The class is named
/// `HippiusFinderSync` (not `FinderSync`) so it doesn't shadow the framework
/// module — see Info.plist `NSExtensionPrincipalClass`.
final class HippiusFinderSync: FIFinderSync {
    private let socket: BridgeSocket
    /// Registered Hippius drive roots (from REGISTER_PATH), standardized.
    private var roots: Set<URL> = []
    /// Per-path badge state token (from STATUS), standardized key.
    private var badges: [URL: String] = [:]
    /// URLs that have already received a `setBadgeIdentifier` call. Finder
    /// will not re-ask for items still on screen, so this set is what we
    /// re-query after a reconnect (Apple: record every URL you badge).
    private var displayed: Set<URL> = []
    /// Directories Finder has called `beginObservingDirectory` for.
    private var observedDirectories: Set<URL> = []
    /// Paths a `BADGE_QUERY` is out for, so a folder Finder redraws several
    /// times while the app answers costs one line per path, not one per draw.
    private var pendingQueries: Set<URL> = []
    /// Bound on `pendingQueries`: an app that never answers (an old build
    /// without the verb) must not grow the set for the life of the process.
    private static let maxPendingQueries = 4096

    override init() {
        socket = BridgeSocket(path: HippiusFinderSync.socketPath())
        super.init()

        registerBadges()
        // Monitor the user's REAL home directory so the menu is reachable on
        // any file they might want to share; badges are only painted on Hippius
        // files (see requestBadgeIdentifier). NOTE: `NSHomeDirectory()` is
        // sandbox-redirected to this extension's container — useless for
        // monitoring — so we read the real home from the password database.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: HippiusFinderSync.realHomeDirectory())]

        socket.onLine = { [weak self] line in
            guard let message = WireProtocol.parse(line) else { return }
            DispatchQueue.main.async { self?.handle(message) }
        }
        socket.onDisconnect = { [weak self] in
            DispatchQueue.main.async { self?.forgetBadgePaint() }
        }
        // BridgeSocket self-heals: connect() retries every second until the app
        // is up, and reconnects automatically if the app later restarts.
        socket.connect()
    }

    // MARK: - Inbound messages

    private func handle(_ message: WireProtocol.Inbound) {
        switch message {
        case .registerPath(let url):
            let standardized = url.standardizedFileURL
            roots.insert(standardized)
            // Roots replay on every connect, which is when we re-query the
            // URLs Finder is still showing (it will not call
            // requestBadgeIdentifier again for them).
            requeryDisplayed(under: standardized)
        case .unregisterPath(let url):
            let standardized = url.standardizedFileURL
            roots.remove(standardized)
            clearDisplayed(under: standardized)
        case .status(let state, let url):
            let key = url.standardizedFileURL
            pendingQueries.remove(key)
            displayed.insert(key)
            if state == "clear" {
                badges.removeValue(forKey: key)
                FIFinderSyncController.default().setBadgeIdentifier("", for: url)
            } else {
                badges[key] = state
                FIFinderSyncController.default().setBadgeIdentifier(state, for: url)
            }
        case .refreshRoot(let url):
            requeryDisplayed(under: url.standardizedFileURL)
        }
    }

    // MARK: - Badges

    /// One image per painted `BadgeState` on the Rust side; the identifiers
    /// are the wire tokens. A state without an image here paints nothing,
    /// silently — `src-tauri/tests/finder_socket_pins.rs` checks the list
    /// against the Rust enum.
    private func registerBadges() {
        let controller = FIFinderSyncController.default()
        let specs: [(id: String, symbol: String, label: String)] = [
            ("synced", "checkmark.circle.fill", NSLocalizedString("Synced", comment: "Finder badge")),
            ("syncing", "arrow.triangle.2.circlepath.circle.fill", NSLocalizedString("Syncing", comment: "Finder badge")),
            ("shared", "link.circle.fill", NSLocalizedString("Shared", comment: "Finder badge")),
            ("error", "exclamationmark.circle.fill", NSLocalizedString("Failed", comment: "Finder badge")),
        ]
        for spec in specs {
            if let image = HippiusFinderSync.badgeImage(systemName: spec.symbol) {
                controller.setBadgeImage(image, label: spec.label, forBadgeIdentifier: spec.id)
            }
        }
    }

    /// 320×320, drawn into the full frame — Apple scales and places the
    /// overlay and asks that the artwork itself carry no padding.
    private static func badgeImage(systemName: String) -> NSImage? {
        guard let symbol = NSImage(systemSymbolName: systemName, accessibilityDescription: nil) else {
            return nil
        }
        let size = NSSize(width: 320, height: 320)
        let image = NSImage(size: size, flipped: false) { rect in
            symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Finder is about to show `url`. Apple requires the initial
    /// `setBadgeIdentifier` from this method before it returns; later STATUS
    /// lines are updates for URLs that have already received a badge.
    override func requestBadgeIdentifier(for url: URL) {
        if Thread.isMainThread {
            applyBadgeRequest(for: url)
        } else {
            DispatchQueue.main.sync { self.applyBadgeRequest(for: url) }
        }
    }

    private func applyBadgeRequest(for url: URL) {
        let key = url.standardizedFileURL
        displayed.insert(key)
        let controller = FIFinderSyncController.default()
        if let state = badges[key] {
            controller.setBadgeIdentifier(state, for: url)
            return
        }
        controller.setBadgeIdentifier("", for: url)
        enqueueQuery(for: key)
    }

    override func beginObservingDirectory(at url: URL) {
        observedDirectories.insert(url.standardizedFileURL)
    }

    override func endObservingDirectory(at url: URL) {
        let dir = url.standardizedFileURL
        observedDirectories.remove(dir)
        let stale = displayed.filter { key in
            isDescendant(key, of: dir) && !isUnderAnyObserved(key)
        }
        let controller = FIFinderSyncController.default()
        for key in stale {
            displayed.remove(key)
            badges.removeValue(forKey: key)
            pendingQueries.remove(key)
            controller.setBadgeIdentifier("", for: key)
        }
    }

    /// Clear Finder's paint for cached badges. Keep `displayed` so a
    /// reconnect's REGISTER_PATH replay can re-query what is still on screen;
    /// Finder will not call `requestBadgeIdentifier` again for those items.
    private func forgetBadgePaint() {
        let controller = FIFinderSyncController.default()
        for url in displayed {
            controller.setBadgeIdentifier("", for: url)
        }
        badges.removeAll()
        pendingQueries.removeAll()
    }

    private func requeryDisplayed(under root: URL) {
        let keys = displayed.filter { isDescendant($0, of: root) }
        for key in keys {
            pendingQueries.remove(key)
            enqueueQuery(for: key)
        }
    }

    private func clearDisplayed(under root: URL) {
        let controller = FIFinderSyncController.default()
        let keys = displayed.filter { isDescendant($0, of: root) }
        for key in keys {
            displayed.remove(key)
            badges.removeValue(forKey: key)
            pendingQueries.remove(key)
            controller.setBadgeIdentifier("", for: key)
        }
    }

    /// Ask the app for a badge. Does not plant `""` — callers that need an
    /// initial identifier (the request path) set it first.
    private func enqueueQuery(for key: URL) {
        guard socket.isConnected, isInsideRegisteredRoot(key) else { return }
        guard !pendingQueries.contains(key) else { return }
        if pendingQueries.count >= HippiusFinderSync.maxPendingQueries {
            return
        }
        pendingQueries.insert(key)
        socket.send(WireProtocol.badgeQueryLine(for: key))
    }

    private func isInsideRegisteredRoot(_ url: URL) -> Bool {
        roots.contains { isDescendant(url, of: $0) }
    }

    private func isUnderAnyObserved(_ url: URL) -> Bool {
        observedDirectories.contains { isDescendant(url, of: $0) }
    }

    // MARK: - Menu

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "")
        guard menuKind == .contextualMenuForItems else { return menu }

        // App down / not logged in: a single "open the app" item, no half-working
        // share attempts (the socket is the only way to mint a link).
        if !socket.isConnected {
            addItem(to: menu, title: "Open Hippius to share", action: #selector(openHippius(_:)))
            return menu
        }

        // A single "Share with Hippius" item for every target. The public vs
        // password-protected choice now lives in the app (Google-Drive model):
        // this click only forwards the path, and the app opens its share chooser
        // and mints once the user confirms. The app also re-derives
        // in-drive/outside and file/folder from the path, so no inside/outside
        // hint is sent from here anymore.
        addItem(to: menu, title: "Share with Hippius", action: #selector(shareSelection(_:)))
        return menu
    }

    /// Append a menu item carrying the Hippius logo, targeted at this extension.
    private func addItem(to menu: NSMenu, title: String, action: Selector) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = HippiusFinderSync.menuIcon
        menu.addItem(item)
    }

    /// The Hippius logo rendered next to each menu item, sized for a menu row
    /// (16pt; AppKit scales the 512px source down on retina). Loaded once from
    /// the extension's own bundle — `NSImage(named:)` looks in the host app's
    /// bundle, which an .appex is not, so we resolve the URL explicitly. `nil`
    /// (asset missing) just yields a text-only item rather than a crash.
    private static let menuIcon: NSImage? = {
        let bundle = Bundle(for: HippiusFinderSync.self)
        guard let url = bundle.url(forResource: "HippiusMenuIcon", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 16, height: 16)
        return image
    }()

    private func isDescendant(_ url: URL, of root: URL) -> Bool {
        let target = url.standardizedFileURL.path
        let base = root.standardizedFileURL.path
        return target == base || target.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    /// Forward every selected item to the app as a share request. One `SHARE`
    /// line per URL; the app resolves the path, opens its public/private chooser,
    /// and mints on confirm — this side makes no visibility or in-drive/outside
    /// decision.
    @objc private func shareSelection(_ sender: AnyObject?) {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        for url in urls {
            socket.send(WireProtocol.shareLine(for: url))
        }
    }

    @objc private func openHippius(_ sender: AnyObject?) {
        if let url = URL(string: "hippiusapp://open") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Socket path

    /// The bridge socket, in the app's OWN directory — deliberately not an App
    /// Group container: the non-sandboxed app touching
    /// `~/Library/Group Containers/` cost a TCC "access data from other apps"
    /// prompt on every launch. This sandbox reaches the path through the SBPL
    /// exceptions in `macos/FinderSync.entitlements`.
    ///
    /// Must stay byte-identical to `finder_bridge::endpoint::resolve` on the
    /// Rust side; pinned by `src-tauri/tests/finder_socket_pins.rs`.
    private static func socketPath() -> String {
        realHomeDirectory() + "/.hippius/finder.sock"
    }

    /// The user's real home directory. `NSHomeDirectory()` is sandbox-redirected
    /// inside an app extension; the password database gives the true path.
    private static func realHomeDirectory() -> String {
        if let pw = getpwuid(getuid()) {
            return String(cString: pw.pointee.pw_dir)
        }
        return NSHomeDirectory()
    }
}

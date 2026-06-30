import Cocoa
import FinderSync

/// The Hippius Finder Sync extension.
///
/// Per Apple's guidance the extension does no heavy work: it renders the
/// right-click menu and status badges and forwards the clicked path to the
/// running Hippius app over the App Group socket ([`BridgeSocket`]); the app
/// resolves the path and mints the share. The class is named
/// `HippiusFinderSync` (not `FinderSync`) so it doesn't shadow the framework
/// module — see Info.plist `NSExtensionPrincipalClass`.
final class HippiusFinderSync: FIFinderSync {
    private let socket: BridgeSocket
    /// Registered Hippius drive roots (from REGISTER_PATH), standardized.
    private var roots: Set<URL> = []
    /// Per-path badge state token (from STATUS), standardized key.
    private var badges: [URL: String] = [:]

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
        // BridgeSocket self-heals: connect() retries every second until the app
        // is up, and reconnects automatically if the app later restarts.
        socket.connect()
    }

    // MARK: - Inbound messages

    private func handle(_ message: WireProtocol.Inbound) {
        switch message {
        case .registerPath(let url):
            roots.insert(url.standardizedFileURL)
        case .unregisterPath(let url):
            let standardized = url.standardizedFileURL
            roots.remove(standardized)
            badges = badges.filter { !isDescendant($0.key, of: standardized) }
        case .status(let state, let url):
            let key = url.standardizedFileURL
            if state == "clear" {
                badges.removeValue(forKey: key)
                FIFinderSyncController.default().setBadgeIdentifier("", for: url)
            } else {
                badges[key] = state
                FIFinderSyncController.default().setBadgeIdentifier(state, for: url)
            }
        }
    }

    // MARK: - Badges

    private func registerBadges() {
        let controller = FIFinderSyncController.default()
        let specs: [(id: String, symbol: String)] = [
            ("synced", "checkmark.circle.fill"),
            ("syncing", "arrow.triangle.2.circlepath.circle.fill"),
            ("shared", "link.circle.fill"),
        ]
        for spec in specs {
            if let image = NSImage(systemSymbolName: spec.symbol, accessibilityDescription: spec.id) {
                controller.setBadgeImage(image, label: spec.id, forBadgeIdentifier: spec.id)
            }
        }
    }

    override func requestBadgeIdentifier(for url: URL) {
        if let state = badges[url.standardizedFileURL] {
            FIFinderSyncController.default().setBadgeIdentifier(state, for: url)
        }
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

        // Public share — the label depends on whether the selection is inside a
        // Hippius drive; either way the app re-derives the real action from the path.
        let inside = selectionIsInsideRoots()
        addItem(
            to: menu,
            title: inside ? "Share via Hippius" : "Upload & Share via Hippius",
            action: inside ? #selector(shareSelection(_:)) : #selector(uploadShareSelection(_:))
        )
        // Password-protected share — one item for any target; the app generates
        // the password (no prompt yet) and returns it alongside the link.
        addItem(to: menu, title: "Share via Hippius (Password)", action: #selector(shareSelectionPrivate(_:)))
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

    private func selectionIsInsideRoots() -> Bool {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        guard !urls.isEmpty else { return false }
        return urls.allSatisfy { url in roots.contains { isDescendant(url, of: $0) } }
    }

    private func isDescendant(_ url: URL, of root: URL) -> Bool {
        let target = url.standardizedFileURL.path
        let base = root.standardizedFileURL.path
        return target == base || target.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    @objc private func shareSelection(_ sender: AnyObject?) {
        sendSelection(upload: false)
    }

    @objc private func uploadShareSelection(_ sender: AnyObject?) {
        sendSelection(upload: true)
    }

    /// Password-protected share for every selected item. The app mints the link,
    /// generates the password, and returns both — there is no per-item verb for
    /// in-drive vs outside because the app re-resolves the path.
    @objc private func shareSelectionPrivate(_ sender: AnyObject?) {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        for url in urls {
            socket.send(WireProtocol.sharePrivateLine(for: url))
        }
    }

    /// The app re-resolves the path authoritatively against its drive list, so
    /// the verb here is advisory; we send the one the menu offered.
    private func sendSelection(upload: Bool) {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        for url in urls {
            socket.send(WireProtocol.shareLine(for: url, upload: upload))
        }
    }

    @objc private func openHippius(_ sender: AnyObject?) {
        if let url = URL(string: "hippiusapp://open") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Container path

    private static func socketPath() -> String {
        let group = "V28B5X732P.com.hippius.shared"
        if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) {
            return container.appendingPathComponent("finder.sock").path
        }
        // Fallback to the literal path (matches the Rust side) if the sandbox
        // container API returns nil. Use the REAL home, not the sandbox one.
        return realHomeDirectory() + "/Library/Group Containers/\(group)/finder.sock"
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

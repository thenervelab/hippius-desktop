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

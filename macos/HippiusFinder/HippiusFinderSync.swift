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
        socket.onDisconnect = { [weak self] in
            // The app may start later; retry shortly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self?.socket.connect() }
        }
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

        let item: NSMenuItem
        if !socket.isConnected {
            item = NSMenuItem(title: "Open Hippius to share", action: #selector(openHippius(_:)), keyEquivalent: "")
        } else if selectionIsInsideRoots() {
            item = NSMenuItem(title: "Share via Hippius", action: #selector(shareSelection(_:)), keyEquivalent: "")
        } else {
            item = NSMenuItem(title: "Upload & Share via Hippius", action: #selector(uploadShareSelection(_:)), keyEquivalent: "")
        }
        item.target = self
        menu.addItem(item)
        return menu
    }

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

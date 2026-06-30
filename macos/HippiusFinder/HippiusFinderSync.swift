import Cocoa
import FinderSync

/// Phase 0 stub for the Hippius Finder Sync extension.
///
/// This intentionally does NO real work — Apple spawns multiple short-lived
/// copies of a Finder extension, so all state and networking live in the main
/// Hippius app. Later phases replace the stub with: connect to the Unix-domain
/// socket in the App Group container, build the menu from registered sync
/// roots, paint badges, and forward the clicked path (`SHARE:` / `UPLOAD_SHARE:`).
///
/// The class is deliberately NOT named `FinderSync` to avoid shadowing the
/// `FinderSync` framework module; the Info.plist principal class is
/// `HippiusFinder.HippiusFinderSync`.
final class HippiusFinderSync: FIFinderSync {
    override init() {
        super.init()
        // Smoke test only: monitor the home dir so the menu is reachable from
        // anywhere during Phase 0 verification. Real roots come over the socket.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: NSHomeDirectory())]
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "")
        menu.addItem(withTitle: "Hippius (stub)", action: #selector(shareStub(_:)), keyEquivalent: "")
        return menu
    }

    @objc private func shareStub(_ sender: AnyObject?) {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        NSLog("Hippius Finder stub clicked: \(urls)")
    }
}

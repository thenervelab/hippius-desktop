import Darwin
import Foundation

/// Minimal Unix-domain-socket client to the Hippius app's Finder bridge.
///
/// The app binds the socket inside the App Group container; this connects to it,
/// reads newline-framed lines on a private queue, and writes lines. Finder
/// spawns the extension lazily and the app may not be running, so connection is
/// best-effort: a drop fires `onDisconnect` and the controller schedules a retry.
final class BridgeSocket {
    private let path: String
    private let queue = DispatchQueue(label: "com.hippius.finder.bridge-socket")
    private var fd: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var readBuffer = Data()

    /// Called on the internal queue for each complete inbound line.
    var onLine: ((String) -> Void)?
    /// Called on the internal queue when the connection drops.
    var onDisconnect: (() -> Void)?

    init(path: String) {
        self.path = path
    }

    /// Delay between reconnect attempts. The app may not be running yet (or may
    /// restart), so the socket retries until it succeeds.
    private let reconnectDelay: TimeInterval = 1.0

    /// Start connecting and keep retrying until connected. Safe to call
    /// repeatedly; a no-op while already connected.
    func connect() {
        queue.async { self.attemptConnect() }
    }

    /// Try once; on failure (no listener yet) schedule another attempt. This is
    /// the self-healing loop — a failed *attempt* must retry, not just an
    /// *established* connection that later drops.
    private func attemptConnect() {
        guard fd < 0 else { return }
        if connectLocked() {
            startReadingLocked()
        } else {
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        queue.asyncAfter(deadline: .now() + reconnectDelay) { [weak self] in self?.attemptConnect() }
    }

    /// Whether the socket is currently connected.
    var isConnected: Bool {
        queue.sync { fd >= 0 }
    }

    /// Queue a line for sending (a trailing newline is appended).
    func send(_ line: String) {
        queue.async {
            guard self.fd >= 0 else { return }
            let payload = Array((line + "\n").utf8)
            payload.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                var sent = 0
                while sent < raw.count {
                    let n = Darwin.write(self.fd, base + sent, raw.count - sent)
                    if n <= 0 {
                        self.closeLocked()
                        return
                    }
                    sent += n
                }
            }
        }
    }

    // MARK: - internals (all on `queue`)

    /// Try to establish the connection. Returns true and sets `fd` on success;
    /// returns false (closing any partial descriptor) on failure so the caller
    /// can schedule a retry. Does NOT start reading — `attemptConnect` does.
    private func connectLocked() -> Bool {
        guard fd < 0 else { return true }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = path.utf8CString
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count <= capacity else {
            Darwin.close(descriptor)
            return false
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { dst in
            dst.withMemoryRebound(to: CChar.self, capacity: capacity) { dstChars in
                pathBytes.withUnsafeBufferPointer { src in
                    if let base = src.baseAddress {
                        dstChars.update(from: base, count: pathBytes.count)
                    }
                }
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, size) }
        }
        guard rc == 0 else {
            Darwin.close(descriptor)
            return false
        }
        fd = descriptor
        readBuffer.removeAll(keepingCapacity: true)
        return true
    }

    private func startReadingLocked() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        source.setCancelHandler { [weak self] in self?.handleClosed() }
        readSource = source
        source.resume()
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 4096)
        let n = Darwin.read(fd, &chunk, chunk.count)
        if n <= 0 {
            readSource?.cancel()
            return
        }
        readBuffer.append(contentsOf: chunk[0..<n])
        while let newline = readBuffer.firstIndex(of: 0x0A) {
            let lineData = readBuffer.subdata(in: readBuffer.startIndex..<newline)
            readBuffer.removeSubrange(readBuffer.startIndex...newline)
            if let line = String(data: lineData, encoding: .utf8) {
                onLine?(line)
            }
        }
    }

    private func handleClosed() {
        closeLocked()
        onDisconnect?()
        // Keep trying to reconnect (the app may have restarted).
        scheduleReconnect()
    }

    private func closeLocked() {
        readSource = nil
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
    }
}

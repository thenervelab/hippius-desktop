import Foundation

/// Wire codec mirroring the Rust `finder_bridge::protocol` EXACTLY: one message
/// per line, the verb/argument split on the FIRST `:` only, and the path
/// percent-encoded (escape `%`, control bytes, `0x7F`, and every byte `>=0x80`)
/// so any path — including `:`, newlines, and non-UTF-8 names — round-trips.
///
/// The two implementations must agree byte-for-byte; the Rust side is pinned by
/// `protocol.rs`'s proptest bijection. Any change here needs the same change there.
enum WireProtocol {
    /// A message the app sends to this extension.
    enum Inbound {
        case registerPath(URL)
        case unregisterPath(URL)
        case status(state: String, path: URL)
    }

    /// Parse one inbound wire line (without its trailing newline).
    static func parse(_ line: String) -> Inbound? {
        guard let (verb, rest) = splitFirst(line, on: ":") else { return nil }
        switch verb {
        case "REGISTER_PATH":
            return decodePath(rest).map(Inbound.registerPath)
        case "UNREGISTER_PATH":
            return decodePath(rest).map(Inbound.unregisterPath)
        case "STATUS":
            guard let (state, encoded) = splitFirst(rest, on: ":"), let url = decodePath(encoded) else { return nil }
            return .status(state: state, path: url)
        default:
            return nil
        }
    }

    /// Encode a `SHARE` / `UPLOAD_SHARE` line for a clicked file URL.
    static func shareLine(for url: URL, upload: Bool) -> String {
        let verb = upload ? "UPLOAD_SHARE" : "SHARE"
        return "\(verb):\(encodePath(url))"
    }

    // MARK: - Path codec (mirrors Rust encode_path / decode_path)

    /// Percent-encode a file URL's raw filesystem bytes to printable ASCII.
    static func encodePath(_ url: URL) -> String {
        var out = ""
        out.reserveCapacity(64)
        for byte in fileSystemBytes(url) {
            if byte >= 0x20, byte <= 0x7E, byte != UInt8(ascii: "%") {
                out.unicodeScalars.append(UnicodeScalar(byte))
            } else {
                out.append("%")
                out.append(hexDigit(byte >> 4))
                out.append(hexDigit(byte & 0x0F))
            }
        }
        return out
    }

    /// Inverse of `encodePath`: decode `%XX` escapes back to raw bytes and build
    /// a file URL. Returns nil on a truncated or non-hex escape.
    static func decodePath(_ encoded: String) -> URL? {
        let input = Array(encoded.utf8)
        var bytes = [UInt8]()
        bytes.reserveCapacity(input.count)
        var i = 0
        while i < input.count {
            if input[i] == UInt8(ascii: "%") {
                guard i + 2 < input.count, let hi = hexValue(input[i + 1]), let lo = hexValue(input[i + 2]) else {
                    return nil
                }
                bytes.append((hi << 4) | lo)
                i += 3
            } else {
                bytes.append(input[i])
                i += 1
            }
        }
        var cString = bytes.map { CChar(bitPattern: $0) }
        cString.append(0)
        return cString.withUnsafeBufferPointer { buffer in
            buffer.baseAddress.map { URL(fileURLWithFileSystemRepresentation: $0, isDirectory: false, relativeTo: nil) }
        }
    }

    /// The URL's path as raw filesystem bytes (NUL-terminated representation,
    /// minus the terminator) — the exact bytes the Rust side percent-decodes to.
    static func fileSystemBytes(_ url: URL) -> [UInt8] {
        url.withUnsafeFileSystemRepresentation { pointer in
            guard let pointer = pointer else { return [] }
            var bytes = [UInt8]()
            var i = 0
            while pointer[i] != 0 {
                bytes.append(UInt8(bitPattern: pointer[i]))
                i += 1
            }
            return bytes
        }
    }

    // MARK: - Helpers

    private static func splitFirst(_ string: String, on separator: Character) -> (String, String)? {
        guard let index = string.firstIndex(of: separator) else { return nil }
        return (String(string[string.startIndex..<index]), String(string[string.index(after: index)...]))
    }

    private static func hexDigit(_ nibble: UInt8) -> Character {
        let table: [Character] = Array("0123456789ABCDEF")
        return table[Int(nibble)]
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
        default: return nil
        }
    }
}

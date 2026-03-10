export const resolveArionHash = (hash: string): string => {
    if (!hash) return "";

    // Check if it's a legacy IPFS CID (starts with 'Qm' or 'bafk')
    if (hash.startsWith("Qm") || hash.startsWith("bafk")) {
        return hash;
    }

    // A 64-char hex string is a SHA256 Arion hash — return as-is
    if (/^[0-9a-f]{64}$/i.test(hash)) {
        return hash;
    }

    // Check if it's a hex-encoded legacy string
    if (/^[0-9a-f]+$/i.test(hash) && hash.length > 16) {
        try {
            const hexToAscii =
                hash
                    .match(/.{1,2}/g)
                    ?.map((hex: string) => String.fromCharCode(parseInt(hex, 16)))
                    .join("") || "";

            if (hexToAscii.startsWith("Qm") || hexToAscii.startsWith("bafk")) {
                return hexToAscii;
            }

            try {
                const bytes = new Uint8Array(
                    hash.match(/.{1,2}/g)!.map((hex) => parseInt(hex, 16))
                );
                const utf8Decoder = new TextDecoder("utf-8");
                const decodedString = utf8Decoder.decode(bytes);

                if (
                    decodedString.startsWith("Qm") ||
                    decodedString.startsWith("bafk") ||
                    decodedString.startsWith("bafy") ||
                    decodedString.startsWith("b")
                ) {
                    return decodedString;
                }
            } catch (e) {
                console.warn("Error with UTF-8 decoding approach:", e);
            }

            if (hash.startsWith("626166")) {
                try {
                    const hexPairs = hash.match(/.{1,2}/g) || [];
                    const chars = hexPairs.map((hex) =>
                        String.fromCharCode(parseInt(hex, 16))
                    );
                    return chars.join("");
                } catch (e) {
                    console.warn("Error with specific prefix decoding:", e);
                }
            }
        } catch (e) {
            console.warn("Error resolving Arion hash:", e);
        }
    }

    // Return original if resolution failed
    return hash;
};

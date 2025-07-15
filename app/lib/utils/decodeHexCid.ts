export const decodeHexCid = (hexCid: string): string => {
    if (!hexCid) return "";

    // Check if it's already a decoded CID (starts with 'Qm' or 'bafk')
    if (hexCid.startsWith("Qm") || hexCid.startsWith("bafk")) {
        return hexCid;
    }

    // Check if it's a hex string
    if (/^[0-9a-f]+$/i.test(hexCid) && hexCid.length > 16) {
        try {
            // First try the standard hex to ASCII conversion
            const hexToAscii =
                hexCid
                    .match(/.{1,2}/g)
                    ?.map((hex: string) => String.fromCharCode(parseInt(hex, 16)))
                    .join("") || "";

            // If the result starts with a valid CID prefix, return it
            if (hexToAscii.startsWith("Qm") || hexToAscii.startsWith("bafk")) {
                return hexToAscii;
            }

            // If the standard conversion didn't work, try a different approach
            // Some systems encode the CID as hex but it's actually a base58 or base32 encoded string
            // Try to convert from hex to UTF-8 string
            try {
                // For CIDs that might be double-encoded (hex of a string representation)
                const bytes = new Uint8Array(
                    hexCid.match(/.{1,2}/g)!.map((hex) => parseInt(hex, 16))
                );
                const utf8Decoder = new TextDecoder("utf-8");
                const decodedString = utf8Decoder.decode(bytes);

                // Check if the decoded string looks like a CID
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

            // If the CID starts with specific prefixes known for IPFS CIDs in hex
            // Common prefixes for CIDv1 in hex:
            // - 'bafk' -> 62 61 66 6b in hex
            // - 'bafy' -> 62 61 66 79 in hex
            if (hexCid.startsWith("626166")) {
                // Starts with 'baf' in hex
                try {
                    // Convert from hex to UTF-8
                    const hexPairs = hexCid.match(/.{1,2}/g) || [];
                    const chars = hexPairs.map((hex) =>
                        String.fromCharCode(parseInt(hex, 16))
                    );
                    return chars.join("");
                } catch (e) {
                    console.warn("Error with specific prefix decoding:", e);
                }
            }
        } catch (e) {
            console.warn("Error decoding hex CID:", e);
        }
    }

    // Return original if decoding failed
    return hexCid;
};

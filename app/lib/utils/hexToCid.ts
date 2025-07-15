export function hexToCid(hex: string): string | null {
    if (!hex) return null;

    // 1. remove 0x if it’s there
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;

    try {
        // 2. turn every two hex chars into a byte
        const bytePairs = clean.match(/.{1,2}/g)!;
        const bytes = new Uint8Array(
            bytePairs.map((b) => parseInt(b, 16))
        );

        // 3. decode to UTF-8
        const cid = new TextDecoder().decode(bytes);

        // 4. (optional) sanity-check prefix
        if (!cid) return null;
        return cid;
    } catch (err) {
        console.error("hexToCid error:", err);
        return null;
    }
}


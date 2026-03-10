export function hexToArionHash(hex: string): string | null {
    if (!hex) return null;

    // remove 0x if it's there
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;

    try {
        const bytePairs = clean.match(/.{1,2}/g)!;
        const bytes = new Uint8Array(
            bytePairs.map((b) => parseInt(b, 16))
        );

        const hash = new TextDecoder().decode(bytes);

        if (!hash) return null;
        return hash;
    } catch (err) {
        console.error("hexToArionHash error:", err);
        return null;
    }
}


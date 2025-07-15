export const hexToAsciiString = (hex: string): string => {
    if (!hex) return "";

    const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;

    try {
        return (
            cleanHex
                .match(/.{1,2}/g)
                ?.map((byte) => String.fromCharCode(parseInt(byte, 16)))
                .join("") || ""
        );
    } catch (error) {
        console.error("Failed to convert hex to ASCII string:", error);
        return "";
    }
};

export const getFileNameFromBytes = (fileName: number[]): string => {
    // Assume it's an array of numbers (bytes)
    try {
        const bytes = new Uint8Array(fileName);
        const decoder = new TextDecoder("utf-8");
        return decoder.decode(bytes);
    } catch (e) {
        console.warn("Error decoding file name bytes:", e);
        return "";
    }
};

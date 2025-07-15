export const getMinerIdFromBytes = (minerId: string | number[]) => {
    let minerIdStr: string;
    if (typeof minerId === "string") {
        minerIdStr = minerId;
    } else if (Array.isArray(minerId)) {
        // Handle bit arrays or byte arrays
        try {
            // Try to convert array of numbers to a string
            minerIdStr = Array.isArray(minerId)
                ? String.fromCharCode(...minerId)
                : String(minerId);
        } catch (e) {
            console.error("Error stringifying minerId:", e);
            // Fallback to JSON representation
            minerIdStr = JSON.stringify(minerId);
        }
    } else if (minerId && typeof minerId === "object") {
        // Handle objects (like Uint8Array or other complex types)
        try {
            minerIdStr = JSON.stringify(minerId);
        } catch (e) {
            console.error("Error stringifying minerId:", e);
            minerIdStr = "Complex ID";
        }
    } else {
        // Default fallback
        minerIdStr = String(minerId);
    }

    return minerIdStr;
};

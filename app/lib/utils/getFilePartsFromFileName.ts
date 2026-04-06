export const getFilePartsFromFileName = (name: string) => {
    // Handle dotfiles like ".gitignore" — no extension
    if (name.startsWith(".") && !name.slice(1).includes(".")) {
        return { fileName: name, fileFormat: "" };
    }
    const lastDot = name.lastIndexOf(".");
    if (lastDot <= 0) {
        return { fileName: name, fileFormat: "" };
    }
    return {
        fileName: name.slice(0, lastDot),
        fileFormat: name.slice(lastDot + 1),
    };
};

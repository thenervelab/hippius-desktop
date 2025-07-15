export const getFilePartsFromFileName = (name: string) => {
    const parts = name.split(".");
    const fileName = parts[0];
    const fileFormat = parts[parts.length - 1];
    return {
        fileName,
        fileFormat,
    };
};

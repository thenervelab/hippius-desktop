import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

export const shouldAllowPreview = (
    file: FormattedUserFile,
    hasCheckmark: boolean,
    isPrivateFolder: boolean
): boolean => {
    if (!isPrivateFolder) return true;
    return hasCheckmark;
};